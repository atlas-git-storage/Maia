import { assertEquals } from "@std/assert";
import { ChunkIndex } from "../src/chunkindex.ts";
import type { GithubClient, Release, ReleaseAsset } from "../src/github.ts";

const CID_A = "a".repeat(64);
const CID_B = "b".repeat(64);

/** A client that counts how many times the releases are paginated (= rebuilds). */
function countingClient(assetsByName: Record<string, number>): {
  client: GithubClient;
  builds: () => number;
} {
  let builds = 0;
  const release: Release = { id: 1, tag_name: "atlas-chunk-v-000001", empty: false };
  const assets: ReleaseAsset[] = Object.entries(assetsByName).map(([name, id]) => ({
    id,
    name,
    size: 10,
  }));
  const client: GithubClient = {
    getRootBody: () => Promise.resolve(null),
    listChunkReleases: () => {
      builds++;
      return Promise.resolve([release]);
    },
    listReleaseAssets: () => Promise.resolve(assets),
    downloadAsset: () => Promise.reject(new Error("n/a")),
  };
  return { client, builds: () => builds };
}

Deno.test("lookup resolves a known chunk after one build", async () => {
  const { client, builds } = countingClient({ [CID_A]: 100 });
  const idx = new ChunkIndex(client);
  assertEquals((await idx.lookup(CID_A))?.id, 100);
  assertEquals((await idx.lookup(CID_A))?.id, 100);
  assertEquals(builds(), 1); // hit is cached; no rebuild
});

Deno.test("repeated misses do NOT rebuild on every lookup (cooldown throttles)", async () => {
  const { client, builds } = countingClient({ [CID_A]: 100 });
  const idx = new ChunkIndex(client);
  // Many lookups for an absent chunk within the cooldown window: the index was
  // just built, so none of them should re-paginate the releases.
  for (let k = 0; k < 5; k++) {
    assertEquals((await idx.lookup(CID_B, 1000 + k))?.id, undefined);
  }
  assertEquals(builds(), 1); // only the initial build
});

Deno.test("a miss after the cooldown window rebuilds and can pick up growth", async () => {
  const store: Record<string, number> = { [CID_A]: 100 };
  let builds = 0;
  const client: GithubClient = {
    getRootBody: () => Promise.resolve(null),
    listChunkReleases: () => {
      builds++;
      return Promise.resolve([{ id: 1, tag_name: "atlas-chunk-v-000001", empty: false }]);
    },
    listReleaseAssets: () =>
      Promise.resolve(Object.entries(store).map(([name, id]) => ({ id, name, size: 10 }))),
    downloadAsset: () => Promise.reject(new Error("n/a")),
  };
  const idx = new ChunkIndex(client);
  assertEquals((await idx.lookup(CID_A, 0))?.id, 100); // initial build at t=0
  // Vault grows.
  store[CID_B] = 200;
  // A miss within the cooldown won't see it yet.
  assertEquals((await idx.lookup(CID_B, 1000))?.id, undefined);
  // A miss past the cooldown rebuilds and finds it.
  assertEquals((await idx.lookup(CID_B, 40_000))?.id, 200);
  assertEquals(builds, 2); // initial build at t=0 + one rebuild past the cooldown
});

Deno.test("releases the listing shows as empty are never asset-listed", async () => {
  const listed: number[] = [];
  const client: GithubClient = {
    getRootBody: () => Promise.resolve(null),
    listChunkReleases: () =>
      Promise.resolve([
        { id: 1, tag_name: "atlas-chunk-v-000001", empty: false },
        { id: 2, tag_name: "atlas-chunk-v-000002", empty: true },
      ]),
    listReleaseAssets: (id) => {
      listed.push(id);
      return Promise.resolve([{ id: 100, name: CID_A, size: 42 }]);
    },
    downloadAsset: () => Promise.reject(new Error("n/a")),
  };
  const idx = new ChunkIndex(client);
  assertEquals(await idx.lookup(CID_A), { id: 100, size: 42 });
  assertEquals(listed, [1]);
});
