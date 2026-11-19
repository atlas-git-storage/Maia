import { assertEquals } from "@std/assert";
import { findSubtitles } from "../src/subtitles.ts";
import type { ManifestEntry } from "../src/types.ts";

const e = (...paths: string[]) =>
  paths.map((p) => ({ p, s: 1, c: [] }) as unknown as ManifestEntry);

Deno.test("same-stem sidecars are found with language labels", () => {
  const subs = findSubtitles(
    e(
      "tv/Show.S01E01.mkv",
      "tv/Show.S01E01.srt",
      "tv/Show.S01E01.en.srt",
      "tv/Show.S01E02.srt",
      "tv/Other.vtt",
    ),
    "tv/Show.S01E01.mkv",
  );
  assertEquals(subs, [
    { path: "tv/Show.S01E01.srt", label: "default" },
    { path: "tv/Show.S01E01.en.srt", label: "en" },
  ]);
});

Deno.test("a Subs/ folder counts when the video is alone, or per-episode by stem", () => {
  assertEquals(
    findSubtitles(e("m/Movie.mp4", "m/Subs/2_English.srt", "m/Subs/readme.txt"), "m/Movie.mp4"),
    [{ path: "m/Subs/2_English.srt", label: "2_English" }],
  );
  assertEquals(
    findSubtitles(
      e("A.mkv", "B.mkv", "Subs/A/3_English.srt", "Subs/B/3_English.srt", "Subs/x.srt"),
      "A.mkv",
    ),
    [{ path: "Subs/A/3_English.srt", label: "3_English" }],
  );
});
