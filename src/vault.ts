/**
 * Vault orchestration: ties the GitHub client, chunk index, and parsers into
 * the read operations the server needs. Owns the caches:
 *   - ROOT doc: single value, short TTL (new snapshots appear without redeploy).
 *   - manifest: per snapshot id, process-life (immutable per id), with a
 *     path -> entry map so per-request lookups (every video Range request)
 *     are O(1).
 *   - decrypted chunks: a small byte-bounded LRU shared across requests, plus
 *     in-flight de-duplication. Video players fire several overlapping Range
 *     requests for the same region (probe, moov atom, resume after seek); each
 *     would otherwise re-download and re-decrypt the same multi-MB chunk.
 */

import type { GithubClient } from "./github.ts";
import { type AssetInfo, ChunkIndex } from "./chunkindex.ts";
import type { ChunkRef, Manifest, ManifestEntry, RootDoc, Snapshot } from "./types.ts";
import { parseManifestPointer, parseRootBody } from "./rootdoc.ts";
import { decodeManifest } from "./manifest.ts";
import {
  bytesToHex,
  decryptChunk,
  hexToCid,
  hexToKey,
  openPointer,
  type PointerSealing,
  TAG_LEN,
} from "./crypto.ts";
import { BadVaultError, NotFoundError } from "./errors.ts";

const ROOT_TTL_MS = 60_000;
/**
 * Byte budget for cached decrypted chunks. Sized to hold a few default-size
 * (~20 MiB avg) atlas chunks while staying well inside a 512 MB instance.
 */
const CHUNK_CACHE_BYTES = 128 * 1024 * 1024;
/** atlas's ROOT field name for snapshot manifest pointers (`_POINTER_FIELD`). */
const SNAPSHOT_POINTER_FIELD = "snapshot-manifest";

interface LoadedManifest {
  manifest: Manifest;
  byPath: Map<string, ManifestEntry>;
}

export class Vault {
  #client: GithubClient;
  #index: ChunkIndex;
  #sealing: PointerSealing | undefined;
  #root: { doc: RootDoc; at: number } | null = null;
  #manifests = new Map<string, Promise<LoadedManifest>>();
  /** cid hex -> plaintext; Map insertion order is the LRU order. */
  #chunkCache = new Map<string, Uint8Array>();
  #chunkCacheBytes = 0;
  #inflight = new Map<string, Promise<Uint8Array>>();

  /**
   * `sealing` opens the sealed ROOT pointers written by atlas >= 0.2.0. Without
   * it, only vaults with legacy (plaintext) pointers can be read.
   */
  constructor(client: GithubClient, sealing?: PointerSealing) {
    this.#client = client;
    this.#index = new ChunkIndex(client);
    this.#sealing = sealing;
  }

  /** Load the ROOT doc, using a short TTL cache. */
  async loadRoot(now: number = Date.now()): Promise<RootDoc> {
    if (this.#root && now - this.#root.at < ROOT_TTL_MS) return this.#root.doc;
    const body = await this.#client.getRootBody();
    if (body === null) {
      throw new NotFoundError("vault ROOT release not found (check owner/repo/vault id)");
    }
    const doc = parseRootBody(body);
    if (doc.vaultMode !== "snapshot") {
      throw new BadVaultError(
        `maia supports snapshot vaults only, got vault_mode=${doc.vaultMode}`,
      );
    }
    this.#root = { doc, at: now };
    return doc;
  }

  /** List snapshots (newest-last, as atlas stores them). */
  async listSnapshots(): Promise<Snapshot[]> {
    return (await this.loadRoot()).snapshots;
  }

  /**
   * Resolve a `<snap>` selector to a snapshot. Accepts an exact id, a unique
   * id prefix, or an exact name. Ambiguous prefixes/names are rejected.
   */
  async getSnapshot(selector: string): Promise<Snapshot> {
    const snaps = await this.listSnapshots();

    const byId = snaps.find((s) => s.id === selector);
    if (byId) return byId;

    const byName = snaps.filter((s) => s.name === selector);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new NotFoundError(`ambiguous snapshot name '${selector}' (use the id)`);
    }

    if (selector.length >= 4) {
      const byPrefix = snaps.filter((s) => s.id.startsWith(selector));
      if (byPrefix.length === 1) return byPrefix[0]!;
      if (byPrefix.length > 1) {
        throw new NotFoundError(`ambiguous snapshot id prefix '${selector}'`);
      }
    }

    throw new NotFoundError(`snapshot '${selector}' not found`);
  }

  /** Load and cache a snapshot's manifest (immutable per snapshot id). */
  async loadManifest(snapshot: Snapshot): Promise<Manifest> {
    return (await this.#loadManifest(snapshot)).manifest;
  }

  /** Find a file entry in a snapshot by its relative path, or undefined. */
  async findEntry(snapshot: Snapshot, path: string): Promise<ManifestEntry | undefined> {
    return (await this.#loadManifest(snapshot)).byPath.get(path);
  }

  /** Find a file entry in a snapshot by its relative path. */
  async resolveEntry(snapshot: Snapshot, path: string): Promise<ManifestEntry> {
    const entry = await this.findEntry(snapshot, path);
    if (!entry) throw new NotFoundError(`path '${path}' not found in snapshot`);
    return entry;
  }

  /** Plaintext length of a file chunk, from its asset size — no download. */
  async chunkLength(ref: ChunkRef): Promise<number> {
    const { size } = await this.#asset(bytesToHex(ref.cid));
    if (size < TAG_LEN) throw new BadVaultError(`chunk asset is ${size} bytes, below the tag size`);
    return size - TAG_LEN;
  }

  /**
   * Fetch + decrypt one of a file's chunks (raw-bytes ref). Served from the
   * shared chunk cache when possible; concurrent reads of one chunk share a
   * single download.
   */
  readChunk(ref: ChunkRef): Promise<Uint8Array> {
    const cidHex = bytesToHex(ref.cid);
    const cached = this.#chunkCache.get(cidHex);
    if (cached) {
      // Refresh LRU position.
      this.#chunkCache.delete(cidHex);
      this.#chunkCache.set(cidHex, cached);
      return Promise.resolve(cached);
    }
    const pending = this.#inflight.get(cidHex);
    if (pending) return pending;
    const p = this.#fetchAsset(cidHex)
      .then((asset) => {
        const pt = decryptChunk(ref.key, asset);
        this.#cachePut(cidHex, pt);
        return pt;
      })
      .finally(() => this.#inflight.delete(cidHex));
    this.#inflight.set(cidHex, p);
    return p;
  }

  #loadManifest(snapshot: Snapshot): Promise<LoadedManifest> {
    const cached = this.#manifests.get(snapshot.id);
    if (cached) return cached;
    const p = this.#fetchManifest(snapshot);
    this.#manifests.set(snapshot.id, p);
    // Don't pin a failure (transient GitHub error) for the process lifetime.
    p.catch(() => this.#manifests.delete(snapshot.id));
    return p;
  }

  async #fetchManifest(snapshot: Snapshot): Promise<LoadedManifest> {
    const pointer = openPointer(this.#sealing, snapshot.manifest, SNAPSHOT_POINTER_FIELD);
    const refs = parseManifestPointer(pointer);
    const parts = await Promise.all(refs.map(async (ref) => {
      // Validate the cid hex (length-checks), then look it up by its hex form.
      const cid = hexToCid(ref.cidHex);
      const key = hexToKey(ref.keyHex);
      return decryptChunk(key, await this.#fetchAsset(bytesToHex(cid)));
    }));
    const manifest = decodeManifest(concat(parts));
    return { manifest, byPath: new Map(manifest.entries.map((e) => [e.p, e])) };
  }

  #cachePut(cidHex: string, pt: Uint8Array): void {
    if (pt.length > CHUNK_CACHE_BYTES) return;
    this.#chunkCache.set(cidHex, pt);
    this.#chunkCacheBytes += pt.length;
    for (const [k, v] of this.#chunkCache) {
      if (this.#chunkCacheBytes <= CHUNK_CACHE_BYTES) break;
      this.#chunkCache.delete(k);
      this.#chunkCacheBytes -= v.length;
    }
  }

  async #asset(cidHex: string): Promise<AssetInfo> {
    const asset = await this.#index.lookup(cidHex);
    if (asset === undefined) {
      throw new NotFoundError(`chunk ${cidHex} not found in vault releases`);
    }
    return asset;
  }

  async #fetchAsset(cidHex: string): Promise<Uint8Array> {
    return await this.#client.downloadAsset((await this.#asset(cidHex)).id);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
