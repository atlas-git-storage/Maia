/**
 * Minimal GitHub REST client for the atlas read path. Read-only.
 *
 * Auth: every api.github.com call sends `Authorization: Bearer <PAT>`. The one
 * exception is the actual asset *download*, which GitHub 302-redirects to a
 * signed object-store URL — we must NOT forward the Authorization header there
 * (the store rejects it, and forwarding would leak the PAT cross-origin).
 */

import { UpstreamError, UpstreamUnavailableError } from "./errors.ts";

const API_BASE = "https://api.github.com";
/** Waits before each retry of a transient failure (so 1 + length attempts). */
const RETRY_DELAYS_MS = [500, 1500];
/** API JSON calls; GitHub itself gives up after ~10 s with a 504. */
const API_TIMEOUT_MS = 30_000;
/** Chunk downloads are a few MB; allow for a slow link. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/**
 * Page sizes for the releases listing. Each release embeds its asset list
 * (up to 1000 assets), so 100 releases per page can be too big for GitHub to
 * build in time (504). On a timeout the listing continues at the next smaller
 * size; each divides the one before, so the item offset stays page-aligned.
 */
const RELEASE_PAGE_SIZES = [100, 20, 5];
const USER_AGENT = "maia/0.1 (+https://github.com/RushiVivek/maia)";

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

export interface Release {
  id: number;
  tag_name: string;
  /**
   * True iff the releases listing embedded an EMPTY asset list, which is
   * conclusive (no assets) — the indexer can skip listing it. A non-empty
   * embedded list may be truncated, so those are always listed exactly.
   */
  empty: boolean;
}

export interface GithubClient {
  /** ROOT release body for `atlas-root-<vaultId>`, or null if the tag is absent. */
  getRootBody(): Promise<string | null>;
  /** All releases whose tag starts with `atlas-chunk-<vaultId>-`. */
  listChunkReleases(): Promise<Release[]>;
  /** All assets of a release (paginated). */
  listReleaseAssets(releaseId: number): Promise<ReleaseAsset[]>;
  /** Raw ciphertext bytes for an asset (follows the signed-URL redirect). */
  downloadAsset(assetId: number): Promise<Uint8Array>;
}

export interface GithubConfig {
  owner: string;
  repo: string;
  vaultId: string;
  token: string;
}

export function createGithubClient(cfg: GithubConfig): GithubClient {
  const { owner, repo, vaultId, token } = cfg;
  const apiHeaders: HeadersInit = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };

  function api(path: string, retries = RETRY_DELAYS_MS.length): Promise<Response> {
    return fetchRetrying(
      `GET ${path}`,
      `${API_BASE}${path}`,
      {
        headers: apiHeaders,
      },
      API_TIMEOUT_MS,
      retries,
    );
  }

  async function apiJson<T>(path: string, retries?: number): Promise<T> {
    const res = await api(path, retries);
    if (!res.ok) throw await upstreamError(`GET ${path}`, res);
    return await res.json() as T;
  }

  return {
    async getRootBody(): Promise<string | null> {
      const tag = `atlas-root-${vaultId}`;
      const res = await api(`/repos/${owner}/${repo}/releases/tags/${tag}`);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw await upstreamError(`ROOT tag ${tag}`, res);
      const release = await res.json() as { body?: string | null };
      return release.body ?? "";
    },

    async listChunkReleases(): Promise<Release[]> {
      const prefix = `atlas-chunk-${vaultId}-`;
      const out: Release[] = [];
      let sizeIdx = 0;
      let offset = 0; // releases read so far; always a multiple of the current size
      for (;;) {
        const size = RELEASE_PAGE_SIZES[sizeIdx]!;
        const smallest = sizeIdx === RELEASE_PAGE_SIZES.length - 1;
        let releases: Array<{ id: number; tag_name: string; assets?: unknown[] }>;
        try {
          // Above the smallest size, a timeout means "page too big": shrink
          // right away instead of retrying the same slow request.
          releases = await apiJson(
            `/repos/${owner}/${repo}/releases?per_page=${size}&page=${offset / size + 1}`,
            smallest ? undefined : 0,
          );
        } catch (e) {
          if (e instanceof UpstreamUnavailableError && !smallest) {
            sizeIdx++;
            continue;
          }
          throw e;
        }
        for (const r of releases) {
          if (r.tag_name.startsWith(prefix)) {
            out.push({
              id: r.id,
              tag_name: r.tag_name,
              empty: Array.isArray(r.assets) && r.assets.length === 0,
            });
          }
        }
        offset += releases.length;
        if (releases.length < size) break;
      }
      return out;
    },

    async listReleaseAssets(releaseId: number): Promise<ReleaseAsset[]> {
      const out: ReleaseAsset[] = [];
      for (let page = 1;; page++) {
        const assets = await apiJson<ReleaseAsset[]>(
          `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
        );
        for (const a of assets) out.push({ id: a.id, name: a.name, size: a.size });
        if (assets.length < 100) break;
      }
      return out;
    },

    async downloadAsset(assetId: number): Promise<Uint8Array> {
      const path = `/repos/${owner}/${repo}/releases/assets/${assetId}`;
      // Request the binary; handle the redirect manually so we can strip auth.
      const res = await fetchRetrying(`asset ${assetId}`, `${API_BASE}${path}`, {
        headers: { ...apiHeaders, "Accept": "application/octet-stream" },
        redirect: "manual",
      }, API_TIMEOUT_MS);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new UpstreamError(`asset ${assetId} redirect missing Location`);
        // Follow to the signed store URL WITHOUT the Authorization header.
        // The signed URL is short-lived but valid for minutes, so it can be retried.
        const signed = await fetchRetrying(`asset ${assetId} download`, location, {
          headers: { "User-Agent": USER_AGENT },
        }, DOWNLOAD_TIMEOUT_MS);
        if (!signed.ok) throw await upstreamError(`asset ${assetId} download`, signed);
        try {
          return new Uint8Array(await signed.arrayBuffer());
        } catch (e) {
          throw new UpstreamUnavailableError(`asset ${assetId} download: ${errMessage(e)}`);
        }
      }

      if (!res.ok) throw await upstreamError(`asset ${assetId}`, res);
      // No redirect (some setups serve inline): body is the ciphertext.
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

function isTransient(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * fetch, retrying network errors, timeouts and transient 5xx (502/503/504)
 * with backoff. Returns the final response (possibly a non-transient error
 * status for the caller to report); throws UpstreamUnavailableError when the
 * request never got through.
 */
async function fetchRetrying(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries = RETRY_DELAYS_MS.length,
): Promise<Response> {
  for (let attempt = 0;; attempt++) {
    let res: Response | undefined;
    let error: unknown;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      error = e;
    }
    if (res && !isTransient(res.status)) return res;
    if (attempt >= Math.min(retries, RETRY_DELAYS_MS.length)) {
      if (res) return res; // transient status: upstreamError() maps it to 503
      throw new UpstreamUnavailableError(`${label}: ${errMessage(error)}`);
    }
    await res?.body?.cancel();
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

/** The error for a failed response: 503 if GitHub was unavailable, else 502. */
async function upstreamError(label: string, res: Response): Promise<Error> {
  const detail = `${label} -> ${res.status} ${res.statusText}${await safeBody(res)}`;
  return isTransient(res.status) ? new UpstreamUnavailableError(detail) : new UpstreamError(detail);
}

/** Read a short snippet of an error response body for diagnostics (never logged file content). */
async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? `: ${text.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}
