/**
 * Embedded MKV/WebM text subtitles, collected from the video bytes Maia is
 * already streaming — no extra download.
 *
 * Every video stream of a Matroska file is teed through a SubtitleScanner; the
 * cues it finds are stored per file. The player page polls for new cues and
 * adds them to a TextTrack. The browser buffers video ahead of the playhead,
 * so each line arrives seconds before it is due; after a seek, cues come from
 * the new position onward. Cues found by any viewer's stream are shared.
 */

import type { ManifestEntry } from "./types.ts";
import { type ChunkReader, planRange, rangeStream } from "./reconstruct.ts";
import {
  cueText,
  type MkvHeader,
  readMkvHeader,
  SubtitleScanner,
  type SubtitleTrack,
} from "./mkv.ts";

export interface Cue {
  track: number;
  /** Milliseconds. */
  start: number;
  /** Milliseconds; null when the file stores no duration. */
  end: number | null;
  text: string;
}

export interface PollResult {
  tracks: Omit<SubtitleTrack, "compression">[];
  cues: Cue[];
  /** Pass back as `after` to get only newer cues. */
  next: number;
}

interface FileSubs {
  header: Promise<MkvHeader | null>;
  cues: Cue[];
  seen: Set<string>;
  /** Text bytes stored (UTF-16 length, close enough for a budget). */
  bytes: number;
}

/** Files whose cues are kept (LRU). Text is small: a film is ~100 KB per track. */
const MAX_FILES = 16;
/**
 * Per-file text budget. A film's full subtitles are ~100 KB per track, so this
 * fits ~20 tracks; past it, further cues are dropped (bounds memory at
 * MAX_FILES × this, whatever the file contains). Cue text itself is capped at
 * MAX_CUE_BYTES by cueText().
 */
const MAX_TEXT_PER_FILE = 2 << 20;

export class EmbeddedSubtitles {
  #reader: ChunkReader;
  #files = new Map<string, FileSubs>();

  constructor(reader: ChunkReader) {
    this.#reader = reader;
  }

  /**
   * Wrap a video byte stream so the subtitles in it are collected. Returns the
   * stream unchanged for a file with no text subtitle tracks, and never lets a
   * subtitle problem disturb playback.
   */
  async tee(
    key: string,
    entry: ManifestEntry,
    stream: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>> {
    const file = this.#file(key, entry);
    let header: MkvHeader | null;
    try {
      header = await file.header;
    } catch (e) {
      console.error("subtitle header:", e instanceof Error ? e.message : String(e));
      return stream;
    }
    if (!header || !header.subtitles.some((t) => t.text)) return stream;

    const tracks = new Map(header.subtitles.map((t) => [t.number, t]));
    const scanner = new SubtitleScanner(header, (raw) => {
      const track = tracks.get(raw.track)!;
      cueText(track, raw.data).then((text) => {
        if (!text) return;
        this.#add(file, { track: raw.track, start: raw.start, end: raw.end, text });
      }).catch(() => {});
    });
    let broken = false;
    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          if (broken) return;
          try {
            scanner.push(chunk);
          } catch (e) {
            broken = true;
            console.error("subtitle scan:", e instanceof Error ? e.message : String(e));
          }
        },
      }),
    );
  }

  /** Subtitle tracks of a file plus the cues collected after index `after`. */
  async poll(key: string, entry: ManifestEntry, after: number): Promise<PollResult> {
    const file = this.#file(key, entry);
    const header = await file.header;
    const tracks = (header?.subtitles ?? []).map(({ compression: _, ...t }) => t);
    const from = Math.max(0, Math.min(after, file.cues.length));
    return { tracks, cues: file.cues.slice(from), next: file.cues.length };
  }

  #add(file: FileSubs, cue: Cue): void {
    if (file.bytes + cue.text.length > MAX_TEXT_PER_FILE) return;
    // Overlapping range requests scan the same clusters; keep each cue once.
    const id = `${cue.track}:${cue.start}:${cue.text}`;
    if (file.seen.has(id)) return;
    file.seen.add(id);
    file.cues.push(cue);
    file.bytes += cue.text.length;
  }

  #file(key: string, entry: ManifestEntry): FileSubs {
    const hit = this.#files.get(key);
    if (hit) {
      this.#files.delete(key);
      this.#files.set(key, hit);
      return hit;
    }
    const file: FileSubs = {
      header: readMkvHeader((offset, len) => this.#readAt(entry, offset, len), entry.s),
      cues: [],
      seen: new Set(),
      bytes: 0,
    };
    // A transient GitHub failure must not stick: forget the file so the next
    // request retries the header.
    file.header.catch(() => {
      if (this.#files.get(key) === file) this.#files.delete(key);
    });
    this.#files.set(key, file);
    while (this.#files.size > MAX_FILES) {
      this.#files.delete(this.#files.keys().next().value!);
    }
    return file;
  }

  /** Read plaintext bytes [offset, offset+len) of a file (clamped to its end). */
  async #readAt(entry: ManifestEntry, offset: number, len: number): Promise<Uint8Array> {
    const end = Math.min(entry.s, offset + len) - 1;
    if (offset > end) return new Uint8Array(0);
    const pieces = await planRange(this.#reader, entry.c, entry.s, offset, end);
    return new Uint8Array(await new Response(rangeStream(this.#reader, pieces)).arrayBuffer());
  }
}
