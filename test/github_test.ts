import { assert, assertEquals } from "@std/assert";
import { createGithubClient } from "../src/github.ts";

const PAT = "ghp_supersecret_pat_value";

interface Captured {
  url: string;
  headers: Headers;
}

/** Install a fake global fetch; returns captured requests + a restore fn. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): {
  calls: Captured[];
  restore: () => void;
} {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(handler(url, init));
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

Deno.test("downloadAsset does NOT forward Authorization to the signed redirect URL", async () => {
  const SIGNED = "https://objects.example.com/signed-blob?sig=abc";
  const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5]);

  const { calls, restore } = stubFetch((url) => {
    if (url.startsWith("https://api.github.com/")) {
      // GitHub redirects asset downloads to a signed object-store URL.
      return new Response(null, { status: 302, headers: { location: SIGNED } });
    }
    if (url === SIGNED) {
      return new Response(PAYLOAD, { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });

  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    const bytes = await client.downloadAsset(42);
    assertEquals(bytes, PAYLOAD);

    assertEquals(calls.length, 2);
    // 1st call hits api.github.com WITH the PAT.
    const api = calls[0]!;
    assert(api.url.startsWith("https://api.github.com/"));
    assertEquals(api.headers.get("authorization"), `Bearer ${PAT}`);
    // 2nd call hits the signed store and must NOT carry the PAT.
    const signed = calls[1]!;
    assertEquals(signed.url, SIGNED);
    assertEquals(signed.headers.get("authorization"), null);
  } finally {
    restore();
  }
});

Deno.test("downloadAsset returns inline body when there is no redirect", async () => {
  const PAYLOAD = new Uint8Array([9, 8, 7]);
  const { restore } = stubFetch(() => new Response(PAYLOAD, { status: 200 }));
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    assertEquals(await client.downloadAsset(1), PAYLOAD);
  } finally {
    restore();
  }
});

Deno.test("getRootBody returns null on a 404 ROOT tag", async () => {
  const { restore } = stubFetch(() => new Response("not found", { status: 404 }));
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    assertEquals(await client.getRootBody(), null);
  } finally {
    restore();
  }
});

Deno.test("transient GitHub failures (504) are retried", async () => {
  let n = 0;
  const { calls, restore } = stubFetch(() => {
    n++;
    return n === 1
      ? new Response("timeout", { status: 504 })
      : Response.json({ body: "ROOT BODY" });
  });
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    assertEquals(await client.getRootBody(), "ROOT BODY");
    assertEquals(calls.length, 2);
  } finally {
    restore();
  }
});

Deno.test("a 504 that persists becomes a 503 UpstreamUnavailableError", async () => {
  const { calls, restore } = stubFetch(() => new Response("timeout", { status: 504 }));
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    const err = await client.getRootBody().then(() => null, (e) => e);
    assertEquals(err?.status, 503);
    assertEquals(calls.length, 3); // 1 + 2 retries
  } finally {
    restore();
  }
});

Deno.test("releases listing shrinks its page size when GitHub times out", async () => {
  // 47 chunk releases; GitHub can only build pages of <= 20 in time.
  const all = Array.from({ length: 47 }, (_, i) => ({
    id: i + 1,
    tag_name: `atlas-chunk-v-${i}`,
    assets: [{}],
  }));
  const { calls, restore } = stubFetch((url) => {
    const u = new URL(url);
    const size = Number(u.searchParams.get("per_page"));
    const page = Number(u.searchParams.get("page"));
    if (size > 20) return new Response("timeout", { status: 504 });
    return Response.json(all.slice((page - 1) * size, page * size));
  });
  try {
    const client = createGithubClient({ owner: "o", repo: "r", vaultId: "v", token: PAT });
    const releases = await client.listChunkReleases();
    assertEquals(releases.map((r) => r.id), all.map((r) => r.id));
    // One failed 100-page (no retry at that size), then pages 1..3 of 20.
    assertEquals(
      calls.map((c) => new URL(c.url).search),
      ["?per_page=100&page=1", "?per_page=20&page=1", "?per_page=20&page=2", "?per_page=20&page=3"],
    );
  } finally {
    restore();
  }
});
