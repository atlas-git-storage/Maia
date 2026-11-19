/**
 * The chunk index: a cached map of chunk_id_hex -> GitHub asset (id + size),
 * built by paginating all `atlas-chunk-<vaultId>-*` releases and their assets.
 *
 * The asset size matters for streaming: a stored asset is ciphertext||16-byte
 * tag, so its plaintext length is `size - 16`. That lets the streamer locate
 * any byte offset without downloading the chunks before it.
 *
 * This is the cold-start cost (100+ releases per vault), so it is built once and
 * held for the process lifetime, listing releases concurrently (and skipping
 * releases the listing already shows as empty, as atlas does). A lookup miss (a
 * manifest references a chunk the map doesn't know — e.g. the vault grew since
 * we built it) refreshes the map, then re-looks-up. That refresh is THROTTLED
 * to at most once per REBUILD_COOLDOWN_MS: otherwise a genuinely-absent chunk
 * would re-paginate every release on every lookup and burn the GitHub rate
 * limit. The cooldown still lets a grown vault be picked up.
 */

import type { GithubClient } from "./github.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const REBUILD_COOLDOWN_MS = 30_000;
/** Concurrent asset-list requests while building; well under GitHub's secondary limit. */
const LIST_CONCURRENCY = 8;

export interface AssetInfo {
  id: number;
  /** Stored (ciphertext||tag) byte size, as GitHub reports it. */
  size: number;
}

export class ChunkIndex {
  #client: GithubClient;
  #map: Map<string, AssetInfo> | null = null;
  #building: Promise<Map<string, AssetInfo>> | null = null;
  /** Wall-clock ms marking the start of the cooldown window; 0 until first build. */
  #lastBuiltAt = 0;

  constructor(client: GithubClient) {
    this.#client = client;
  }

  /**
   * Resolve a chunk_id_hex to its asset. On a miss, refresh the map at most
   * once per cooldown window, then re-look-up. `now` is injectable for tests.
   */
  async lookup(cidHex: string, now: number = Date.now()): Promise<AssetInfo | undefined> {
    const key = cidHex.toLowerCase();
    let map = await this.#ensure(now);
    const hit = map.get(key);
    if (hit !== undefined) return hit;
    if (now - this.#lastBuiltAt >= REBUILD_COOLDOWN_MS) {
      map = await this.#rebuild(now);
    }
    return map.get(key);
  }

  /** Number of indexed chunks (for diagnostics/tests). Builds if needed. */
  async size(): Promise<number> {
    return (await this.#ensure()).size;
  }

  #ensure(now: number = Date.now()): Promise<Map<string, AssetInfo>> {
    if (this.#map) return Promise.resolve(this.#map);
    return this.#rebuild(now);
  }

  #rebuild(now: number): Promise<Map<string, AssetInfo>> {
    // Collapse concurrent rebuilds into one in-flight build.
    if (this.#building) return this.#building;
    this.#building = this.#build().then((m) => {
      this.#map = m;
      this.#lastBuiltAt = now;
      this.#building = null;
      return m;
    }).catch((e) => {
      this.#building = null;
      throw e;
    });
    return this.#building;
  }

  async #build(): Promise<Map<string, AssetInfo>> {
    const map = new Map<string, AssetInfo>();
    const releases = (await this.#client.listChunkReleases()).filter((r) => !r.empty);
    let next = 0;
    const worker = async () => {
      while (next < releases.length) {
        const release = releases[next++]!;
        for (const a of await this.#client.listReleaseAssets(release.id)) {
          const name = a.name.toLowerCase();
          // Only accept assets whose name is exactly a 64-char lowercase hex
          // chunk_id; ignore anything else atlas might attach.
          if (HEX64.test(name)) map.set(name, { id: a.id, size: a.size });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(LIST_CONCURRENCY, releases.length) }, worker),
    );
    return map;
  }
}
