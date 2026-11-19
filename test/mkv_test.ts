import { assert, assertEquals } from "@std/assert";
import {
  cueText,
  MAX_CUE_BYTES,
  type MkvHeader,
  type RawCue,
  readMkvHeader,
  SubtitleScanner,
} from "../src/mkv.ts";

// ffmpeg-made: 9 s of 16x16 H.264, track 2 = SRT (eng, "English"), track 3 = ASS (fre),
// ~1 s clusters, CRC-32 elements on. Regenerate: see test/fixture/README.md.
const FILE = Deno.readFileSync(new URL("./fixture/subs.mkv", import.meta.url));
const readAt = (o: number, n: number) => Promise.resolve(FILE.slice(o, o + n));

const EXPECTED = [
  "2@500-1500 Hello <i>world</i>",
  "3@2000-2500 Bonjour, le\nmonde",
  "2@3000-4250 Second line\ntwo rows",
  "3@6000-6750 Fin",
  "2@7000-8000 Late cue",
];

async function scan(header: MkvHeader, from: number, step: number): Promise<string[]> {
  const raw: RawCue[] = [];
  const s = new SubtitleScanner(header, (c) => raw.push(c));
  for (let i = from; i < FILE.length; i += step) s.push(FILE.slice(i, i + step));
  const tracks = new Map(header.subtitles.map((t) => [t.number, t]));
  const out = await Promise.all(
    raw.map(async (c) =>
      `${c.track}@${c.start}-${c.end} ${await cueText(tracks.get(c.track)!, c.data)}`
    ),
  );
  return out.sort((a, b) =>
    Number(a.split("@")[1]!.split("-")[0]) - Number(b.split("@")[1]!.split("-")[0])
  );
}

Deno.test("header lists the subtitle tracks", async () => {
  const h = (await readMkvHeader(readAt, FILE.length))!;
  assertEquals(h.timestampScale, 1_000_000);
  assertEquals(
    h.subtitles.map((t) => [t.number, t.codec, t.language, t.name, t.text]),
    [[2, "S_TEXT/UTF8", "eng", "English", true], [3, "S_TEXT/ASS", "fre", "", true]],
  );
});

Deno.test("non-Matroska bytes have no header", async () => {
  const mp4 = new TextEncoder().encode("\0\0\0 ftypisom....");
  assertEquals(
    await readMkvHeader((o, n) => Promise.resolve(mp4.slice(o, o + n)), mp4.length),
    null,
  );
});

Deno.test("scanner finds every cue, however the stream is split", async () => {
  const h = (await readMkvHeader(readAt, FILE.length))!;
  assertEquals(await scan(h, 0, FILE.length), EXPECTED);
  assertEquals(await scan(h, 0, 1), EXPECTED);
  assertEquals(await scan(h, 0, 7), EXPECTED);
});

Deno.test("a stream starting mid-file resyncs and never invents cues", async () => {
  const h = (await readMkvHeader(readAt, FILE.length))!;
  let previous = EXPECTED.length;
  for (let from = 0; from < FILE.length; from++) {
    const got = await scan(h, from, 64);
    // Always a suffix of the real cues, shrinking as the start moves later.
    assertEquals(got, EXPECTED.slice(EXPECTED.length - got.length), `from ${from}`);
    assert(got.length <= previous, `from ${from}`);
    if (from === 0) assertEquals(got.length, EXPECTED.length);
    previous = got.length;
  }
  assertEquals(previous, 0);
});

Deno.test("zlib-compressed and header-stripped tracks decode", async () => {
  const text = new TextEncoder().encode("compressed line");
  const z = new Uint8Array(
    await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate")))
      .arrayBuffer(),
  );
  const base = {
    number: 2,
    codec: "S_TEXT/UTF8",
    language: "eng",
    name: "",
    default: true,
    forced: false,
    text: true,
  };
  assertEquals(
    await cueText({ ...base, compression: { algo: 0, settings: new Uint8Array() } }, z),
    "compressed line",
  );
  assertEquals(
    await cueText({ ...base, compression: { algo: 3, settings: text.slice(0, 5) } }, text.slice(5)),
    "compressed line",
  );
});

Deno.test("cue text is capped, even from a zlib bomb", async () => {
  const huge = new Uint8Array(10 << 20).fill(0x41); // 10 MiB of "A", ~10 KB compressed
  const z = new Uint8Array(
    await new Response(new Blob([huge]).stream().pipeThrough(new CompressionStream("deflate")))
      .arrayBuffer(),
  );
  const base = {
    number: 2,
    codec: "S_TEXT/UTF8",
    language: "eng",
    name: "",
    default: true,
    forced: false,
    text: true,
  };
  const text = await cueText({ ...base, compression: { algo: 0, settings: new Uint8Array() } }, z);
  assertEquals(text.length, MAX_CUE_BYTES);
  assertEquals((await cueText(base, huge)).length, MAX_CUE_BYTES);
});
