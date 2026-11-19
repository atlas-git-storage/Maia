/**
 * HTTP server: routing, auth wrapping, and error→Response mapping.
 *
 * GET /healthz is answered before auth: it says the process is up and touches
 * neither GitHub nor the vault, so a platform health checker can poll it freely.
 *
 * Routes (all behind withAuth):
 *   GET /                      -> snapshot list (HTML, or JSON if Accept: json)
 *   GET /<snap>/               -> directory listing of a snapshot
 *   GET /<snap>/<dir>/         -> directory listing of a subdir
 *   GET /<snap>/<path>         -> stream a file (Range-aware)
 *   GET /<snap>/<video>?play   -> player page with a subtitle picker
 *   GET /<snap>/<video>?subtitles&after=N
 *                              -> embedded MKV subtitle tracks + cues found so
 *                                 far by streaming (JSON, polled by the player)
 *
 * The whole router is wrapped once in withAuth, so every route is gated.
 */

import type { Config } from "./config.ts";
import { createGithubClient } from "./github.ts";
import { Vault } from "./vault.ts";
import { planRange, rangeStream } from "./reconstruct.ts";
import { parseRange } from "./range.ts";
import { contentType, isMatroska, isVideo } from "./mime.ts";
import { EmbeddedSubtitles } from "./embeddedsubs.ts";
import { findSubtitles } from "./subtitles.ts";
import { decodeSegment, dirExists, listDir, normalizePath } from "./tree.ts";
import { COOKIE_NAME, type Handler, tokensEqual, withAuth } from "./auth.ts";
import { HttpError, NotFoundError, UpstreamError, UpstreamUnavailableError } from "./errors.ts";
import { renderSnapshotList } from "./views/snapshots.ts";
import { renderListing } from "./views/listing.ts";
import { renderPlayer } from "./views/player.ts";

export function buildHandler(config: Config): Deno.ServeHandler {
  const client = createGithubClient({
    owner: config.owner,
    repo: config.repo,
    vaultId: config.vaultId,
    token: config.githubToken,
  });
  const sealing = config.vaultSecret
    ? { vaultId: config.vaultId, secret: config.vaultSecret }
    : undefined;
  return buildHandlerWithVault(config.authToken, new Vault(client, sealing));
}

/** Build the handler around an already-constructed Vault (used by tests). */
export function buildHandlerWithVault(authToken: string, vault: Vault): Deno.ServeHandler {
  const subs = new EmbeddedSubtitles(vault);
  const router: Handler = async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return text(405, "Method Not Allowed");
    }
    try {
      return await route(vault, subs, req, authToken);
    } catch (e) {
      if (e instanceof HttpError) {
        // Upstream messages can carry GitHub error snippets and owner/repo
        // paths — log those server-side and return a generic body. Vault and
        // config errors describe the problem (and its fix) without secrets.
        if (e.status >= 500) console.error("vault error:", e.message);
        if (e instanceof UpstreamUnavailableError) {
          const res = text(
            503,
            "GitHub didn't respond in time (it may be busy). Try again in a minute.",
          );
          res.headers.set("Retry-After", "30");
          return res;
        }
        if (e instanceof UpstreamError) {
          return text(e.status, "Bad Gateway (GitHub request failed)");
        }
        return text(e.status, e.message);
      }
      console.error("unhandled error:", e instanceof Error ? e.message : String(e));
      return text(500, "Internal Server Error");
    }
  };

  const guarded = withAuth(authToken, router);
  const withBootstrap = withCookieBootstrap(authToken, guarded);
  return (req, _info) => {
    if (new URL(req.url).pathname === "/healthz") return text(200, "ok");
    return withBootstrap(req);
  };
}

/**
 * When the request carries a valid `?token=`, (re)set the cookie so subsequent
 * tokenless navigations/asset loads work. We set it even if a cookie is already
 * present, so a stale cookie (after an AUTH_TOKEN rotation) is refreshed by
 * visiting a fresh `?token=` link rather than wedging the browser at 401.
 *
 * A browser navigation is answered with a 303 to the same URL minus `token`,
 * so the secret never stays in the address bar or history. Other clients (VLC,
 * curl) can't hold a cookie, so they are served directly at the token URL.
 */
function withCookieBootstrap(authToken: string, guarded: Handler): Handler {
  const cookie = `${COOKIE_NAME}=${
    encodeURIComponent(authToken)
  }; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
  return async (req) => {
    const url = new URL(req.url);
    const qpToken = url.searchParams.get("token");
    if (
      qpToken !== null && req.method === "GET" && isBrowserNavigation(req) &&
      await tokensEqual(qpToken, authToken)
    ) {
      url.searchParams.delete("token");
      return new Response(null, {
        status: 303,
        headers: {
          "Location": url.pathname + url.search,
          "Set-Cookie": cookie,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    const res = await guarded(req);
    // Set the cookie only when the guard served real content (2xx) and the
    // request's ?token is the valid token (verified CONSTANT-TIME, never with
    // `===` on the raw secret). Gating on 2xx (not merely "not 401") keeps the
    // long-lived auth cookie off redirects and error responses.
    if (
      res.status >= 200 && res.status < 300 && qpToken !== null &&
      await tokensEqual(qpToken, authToken)
    ) {
      const headers = new Headers(res.headers);
      headers.append("Set-Cookie", cookie);
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  };
}

/**
 * A top-level browser page load. Browsers send `Sec-Fetch-Mode: navigate`;
 * older ones without Fetch Metadata are recognised by asking for HTML. VLC and
 * curl send neither.
 */
function isBrowserNavigation(req: Request): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

async function route(
  vault: Vault,
  subs: EmbeddedSubtitles,
  req: Request,
  authToken: string,
): Promise<Response> {
  const url = new URL(req.url);

  // Split path into segments, dropping empties.
  const rawSegments = url.pathname.split("/").filter((s) => s.length > 0);

  // GET /
  if (rawSegments.length === 0) {
    const snaps = await vault.listSnapshots();
    if (wantsJson(req)) {
      return json(200, snaps.map((s) => ({ id: s.id, name: s.name, created: s.created })));
    }
    return html(200, renderSnapshotList(snaps));
  }

  // First segment is the snapshot selector.
  const snapSel = decodeSegment(rawSegments[0]!);
  const snap = await vault.getSnapshot(snapSel);

  // Remaining path (already without snapshot segment).
  const restRaw = rawSegments.slice(1).join("/");
  const path = normalizePath(restRaw);
  // A trailing slash (or empty rest) means "directory listing".
  const isDirRequest = restRaw === "" || url.pathname.endsWith("/");

  const manifest = await vault.loadManifest(snap);

  if (isDirRequest) {
    const prefix = path === "" ? "" : path + "/";
    if (!dirExists(manifest.entries, prefix)) {
      return text(404, `directory '${path}' not found in snapshot`);
    }
    const children = listDir(manifest.entries, prefix);
    if (wantsJson(req)) {
      return json(200, {
        snapshot: { id: snap.id, name: snap.name },
        dir: path,
        children,
      });
    }
    return html(
      200,
      renderListing(
        snap,
        prefix,
        children,
        `?token=${encodeURIComponent(authToken)}`,
        url.origin,
      ),
    );
  }

  // File request: but the path might actually be a directory (no trailing /).
  // If it's a directory, redirect to the trailing-slash form.
  const asDirPrefix = path + "/";
  const entry = await vault.findEntry(snap, path);
  if (!entry && dirExists(manifest.entries, asDirPrefix)) {
    // Safe from header (CRLF) injection: `url` is a parsed URL, so pathname and
    // search are already percent-encoded (control chars cannot appear raw).
    const loc = url.pathname.replace(/\/?$/, "/") + url.search;
    // no-store: the Location may carry ?token=, which must not be cached by an
    // intermediary (308 is cacheable by default).
    return new Response(null, {
      status: 308,
      headers: { "Location": loc, "Cache-Control": "no-store" },
    });
  }

  if (!entry) throw new NotFoundError(`path '${path}' not found in snapshot`);
  if (url.searchParams.has("play") && isVideo(path)) {
    return html(
      200,
      renderPlayer(snap, path, findSubtitles(manifest.entries, path), isMatroska(path)),
    );
  }
  const subsKey = `${snap.id}/${path}`;
  if (url.searchParams.has("subtitles")) {
    if (!isMatroska(path)) return json(200, { tracks: [], cues: [], next: 0 });
    const after = Number(url.searchParams.get("after")) || 0;
    return json(200, await subs.poll(subsKey, entry, after));
  }
  const tee = isMatroska(path)
    ? (body: ReadableStream<Uint8Array>) => subs.tee(subsKey, entry, body)
    : undefined;
  return await streamFile(vault, req, entry.c, entry.s, contentType(path), tee);
}

async function streamFile(
  vault: Vault,
  req: Request,
  chunks: import("./types.ts").ChunkRef[],
  size: number,
  ctype: string,
  /** Observe the body as it streams (embedded subtitle collection). */
  tee?: (body: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array>>,
): Promise<Response> {
  const range = parseRange(req.headers.get("range"), size);

  const baseHeaders: Record<string, string> = {
    "Content-Type": ctype,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    // Vault contents are untrusted: forbid MIME sniffing so the browser honors
    // the declared Content-Type and can't upgrade e.g. a .txt holding <script>
    // into text/html and execute it in maia's (cookie-bearing) origin.
    "X-Content-Type-Options": "nosniff",
  };
  // Anything we don't render inline is forced to download, so a hostile file
  // can never execute as active content in the origin.
  if (ctype === "application/octet-stream") {
    baseHeaders["Content-Disposition"] = "attachment";
  }

  if (range.kind === "unsatisfiable") {
    return new Response("Range Not Satisfiable\n", {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  const status = range.kind === "partial" ? 206 : 200;
  const headers = new Headers(baseHeaders);
  headers.set("Content-Length", String(length));
  if (range.kind === "partial") {
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }

  // HEAD or empty body: no stream needed.
  if (req.method === "HEAD" || size === 0) {
    return new Response(null, { status, headers });
  }

  const pieces = await planRange(vault, chunks, size, start, end);
  const body = rangeStream(vault, pieces);
  return new Response(tee ? await tee(body) : body, { status, headers });
}

// ---- response helpers ----

function wantsJson(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("application/json");
}

function text(status: number, body: string): Response {
  return new Response(body + "\n", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Our HTML uses small inline <script>s (copy-URL button, subtitle
      // loader) and inline CSS; allow those but nothing external. connect-src
      // lets the player fetch sidecar subtitles from this origin only.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; media-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
