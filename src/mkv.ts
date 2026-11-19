/**
 * Just enough Matroska (MKV/WebM, EBML) parsing to pull text subtitles out of
 * the bytes Maia is already streaming to a video player.
 *
 * Subtitle blocks are interleaved with video/audio in Clusters, so a player
 * reading the file meets each line a few seconds before it is due — the same
 * way VLC gets them without reading the whole file. Two parts:
 *   - readMkvHeader: random-access walk of the Segment's top-level elements up
 *     to the first Cluster, to learn the TimestampScale and the subtitle tracks.
 *   - SubtitleScanner: a push parser fed the streamed bytes from ANY offset.
 *     It resyncs on the next Cluster, then reads only element headers, skipping
 *     video/audio payloads without copying them; only subtitle blocks are kept.
 *
 * Element IDs: https://www.matroska.org/technical/elements.html
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  ContentEncryption: 0x5035,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

const TRACK_TYPE_SUBTITLE = 17;
/** Codecs whose block payload is text we can turn into a cue. */
const TEXT_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT"]);
/** Elements that may appear inside an unknown-size Cluster (incl. BlockGroup children). */
const CLUSTER_CHILDREN = new Set<number>([
  ID.Timestamp,
  ID.SimpleBlock,
  ID.BlockGroup,
  ID.Block,
  ID.BlockDuration,
  0xfb, // ReferenceBlock
  0xfa, // ReferencePriority
  0x75a1, // BlockAdditions
  0x75a2, // DiscardPadding
  0xa4, // CodecState
  0xa2, // BlockVirtual
  0x8e, // Slices
  0xa7, // Position
  0xab, // PrevSize
  0xaf, // EncryptedBlock
  0x5854, // SilentTracks
  0xec, // Void
  0xbf, // CRC-32
]);
/** A subtitle block bigger than this is not text; skip it rather than buffer it. */
const MAX_TEXT_BLOCK = 1 << 20;

export interface SubtitleTrack {
  number: number;
  codec: string;
  language: string;
  name: string;
  default: boolean;
  forced: boolean;
  /** Text codec we can render; false for image subs (PGS, VobSub). */
  text: boolean;
  /** Content compression: 0 = zlib, 3 = header stripping (settings prepended). */
  compression?: { algo: number; settings: Uint8Array };
}

export interface MkvHeader {
  /** Nanoseconds per timestamp tick. */
  timestampScale: number;
  subtitles: SubtitleTrack[];
}

/** A raw subtitle block, in milliseconds. `end` is null when no duration was stored. */
export interface RawCue {
  track: number;
  start: number;
  end: number | null;
  data: Uint8Array;
}

// ---- EBML primitives ----

interface Vint {
  value: number;
  len: number;
  /** All value bits set: "unknown size". */
  unknown: boolean;
}

/** Read a variable-length integer. null = need more bytes; "bad" = invalid. */
function readVint(b: Uint8Array, i: number, keepMarker: boolean): Vint | null | "bad" {
  if (i >= b.length) return null;
  const first = b[i]!;
  if (first === 0) return "bad";
  const len = Math.clz32(first) - 23; // 1..8
  if (i + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let k = 1; k < len; k++) {
    const byte = b[i + k]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

interface ElementHeader {
  id: number;
  size: number;
  unknownSize: boolean;
  /** Bytes taken by id + size. */
  headerLen: number;
}

function readElementHeader(b: Uint8Array, i: number): ElementHeader | null | "bad" {
  const id = readVint(b, i, true);
  if (id === null || id === "bad") return id;
  if (id.len > 4) return "bad";
  const size = readVint(b, i + id.len, false);
  if (size === null || size === "bad") return size;
  return {
    id: id.value,
    size: size.value,
    unknownSize: size.unknown,
    headerLen: id.len + size.len,
  };
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (const byte of b) v = v * 256 + byte;
  return v;
}

const utf8 = new TextDecoder();

/** Iterate the children of a fully-buffered master element's body. */
function* children(b: Uint8Array): Generator<{ id: number; body: Uint8Array }> {
  let i = 0;
  while (i < b.length) {
    const h = readElementHeader(b, i);
    if (h === null || h === "bad" || h.unknownSize) return;
    const start = i + h.headerLen;
    yield { id: h.id, body: b.subarray(start, Math.min(b.length, start + h.size)) };
    i = start + h.size;
  }
}

// ---- header ----

/** Random-access read of `len` bytes at `offset` (shorter at end of file). */
export type ReadAt = (offset: number, len: number) => Promise<Uint8Array>;

/** Elements we buffer whole to parse; anything bigger than this is skipped. */
const MAX_HEADER_ELEMENT = 4 << 20;
const MAX_TOP_LEVEL = 64;

/** Learn the timestamp scale and subtitle tracks. Returns null for a non-Matroska file. */
export async function readMkvHeader(read: ReadAt, fileSize: number): Promise<MkvHeader | null> {
  const head = await read(0, 64);
  const ebml = readElementHeader(head, 0);
  if (!ebml || ebml === "bad" || ebml.id !== ID.EBML) return null;
  let pos = ebml.headerLen + ebml.size;
  const seg = readElementHeader(await read(pos, 16), 0);
  if (!seg || seg === "bad" || seg.id !== ID.Segment) return null;
  pos += seg.headerLen;

  const header: MkvHeader = { timestampScale: 1_000_000, subtitles: [] };
  for (let n = 0; n < MAX_TOP_LEVEL && pos < fileSize; n++) {
    const h = readElementHeader(await read(pos, 16), 0);
    if (!h || h === "bad" || h.unknownSize || h.id === ID.Cluster) break;
    const bodyAt = pos + h.headerLen;
    if ((h.id === ID.Info || h.id === ID.Tracks) && h.size <= MAX_HEADER_ELEMENT) {
      const body = await read(bodyAt, h.size);
      if (h.id === ID.Info) {
        for (const c of children(body)) {
          if (c.id === ID.TimestampScale) header.timestampScale = readUint(c.body) || 1_000_000;
        }
      } else {
        header.subtitles = parseTracks(body);
      }
    }
    pos = bodyAt + h.size;
  }
  return header;
}

function parseTracks(body: Uint8Array): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  for (const entry of children(body)) {
    if (entry.id !== ID.TrackEntry) continue;
    const t: SubtitleTrack = {
      number: 0,
      codec: "",
      language: "eng", // Matroska's default
      name: "",
      default: true,
      forced: false,
      text: false,
    };
    let type = 0;
    let encrypted = false;
    for (const c of children(entry.body)) {
      switch (c.id) {
        case ID.TrackNumber:
          t.number = readUint(c.body);
          break;
        case ID.TrackType:
          type = readUint(c.body);
          break;
        case ID.CodecID:
          t.codec = utf8.decode(c.body).replace(/\0+$/, "");
          break;
        case ID.Name:
          t.name = utf8.decode(c.body);
          break;
        case ID.Language:
          if (t.language === "eng") t.language = utf8.decode(c.body).replace(/\0+$/, "");
          break;
        case ID.LanguageBCP47:
          t.language = utf8.decode(c.body).replace(/\0+$/, "");
          break;
        case ID.FlagDefault:
          t.default = readUint(c.body) !== 0;
          break;
        case ID.FlagForced:
          t.forced = readUint(c.body) !== 0;
          break;
        case ID.ContentEncodings:
          for (const enc of children(c.body)) {
            if (enc.id !== ID.ContentEncoding) continue;
            for (const e of children(enc.body)) {
              if (e.id === ID.ContentEncryption) encrypted = true;
              if (e.id !== ID.ContentCompression) continue;
              const comp = { algo: 0, settings: new Uint8Array(0) };
              for (const k of children(e.body)) {
                if (k.id === ID.ContentCompAlgo) comp.algo = readUint(k.body);
                if (k.id === ID.ContentCompSettings) comp.settings = k.body.slice();
              }
              t.compression = comp;
            }
          }
          break;
      }
    }
    if (type !== TRACK_TYPE_SUBTITLE || t.number === 0) continue;
    const compressionOk = !t.compression || t.compression.algo === 0 || t.compression.algo === 3;
    t.text = TEXT_CODECS.has(t.codec) && !encrypted && compressionOk;
    out.push(t);
  }
  return out;
}

// ---- streaming scanner ----

const CLUSTER_MAGIC = [0x1f, 0x43, 0xb6, 0x75];

/**
 * Push parser over a byte stream that may start anywhere in the file. Feed it
 * every streamed chunk with push(); it calls onCue for each text-subtitle block.
 * It never throws on malformed input — it just resyncs on the next Cluster.
 */
export class SubtitleScanner {
  #tracks: Set<number>;
  #scale: number;
  #onCue: (cue: RawCue) => void;

  /** Unconsumed bytes; `#base` is the stream offset of `#buf[0]`. */
  #buf: Uint8Array = new Uint8Array(0);
  #pos = 0;
  #base = 0;
  /** Bytes still to discard from future input (a skipped payload). */
  #skip = 0;

  #inCluster = false;
  #clusterEnd = Infinity;
  #clusterTime = 0;
  #groupEnd = -1;
  #pending: { track: number; start: number; data: Uint8Array } | null = null;
  #pendingDuration: number | null = null;

  constructor(header: MkvHeader, onCue: (cue: RawCue) => void) {
    this.#tracks = new Set(header.subtitles.filter((t) => t.text).map((t) => t.number));
    this.#scale = header.timestampScale / 1_000_000; // ticks -> ms
    this.#onCue = onCue;
  }

  push(chunk: Uint8Array): void {
    if (this.#skip > 0) {
      const n = Math.min(this.#skip, chunk.length);
      this.#skip -= n;
      this.#base += n;
      chunk = chunk.subarray(n);
      if (chunk.length === 0) return;
    }
    const rest = this.#buf.subarray(this.#pos);
    if (rest.length === 0) {
      this.#buf = chunk;
    } else {
      const merged = new Uint8Array(rest.length + chunk.length);
      merged.set(rest);
      merged.set(chunk, rest.length);
      this.#buf = merged;
    }
    this.#base += this.#pos;
    this.#pos = 0;
    this.#run();
    // Keep only what is unconsumed: never hold a reference to a whole chunk.
    if (this.#pos >= this.#buf.length) {
      this.#base += this.#buf.length;
      this.#buf = new Uint8Array(0);
      this.#pos = 0;
    } else if (this.#pos > 0) {
      this.#buf = this.#buf.slice(this.#pos);
      this.#base += this.#pos;
      this.#pos = 0;
    } else if (this.#buf === chunk) {
      this.#buf = chunk.slice();
    }
  }

  #at(i: number): number {
    return this.#base + i;
  }

  /** Consume n bytes, carrying the remainder over to future input if needed. */
  #advance(n: number): void {
    const avail = this.#buf.length - this.#pos;
    if (n <= avail) {
      this.#pos += n;
    } else {
      this.#skip = n - avail;
      this.#pos = this.#buf.length;
    }
  }

  #flushGroup(): void {
    const p = this.#pending;
    if (p) {
      const end = this.#pendingDuration === null
        ? null
        : p.start + this.#pendingDuration * this.#scale;
      this.#onCue({ track: p.track, start: p.start, end, data: p.data });
    }
    this.#pending = null;
    this.#pendingDuration = null;
    this.#groupEnd = -1;
  }

  #leaveCluster(): void {
    this.#flushGroup();
    this.#inCluster = false;
  }

  #run(): void {
    const b = this.#buf;
    while (this.#skip === 0 && this.#pos < b.length) {
      if (!this.#inCluster) {
        if (!this.#seekCluster()) return;
        continue;
      }
      const here = this.#at(this.#pos);
      if (here >= this.#clusterEnd) {
        this.#leaveCluster();
        continue;
      }
      if (this.#groupEnd >= 0 && here >= this.#groupEnd) this.#flushGroup();

      const h = readElementHeader(b, this.#pos);
      if (h === null) return;
      if (h === "bad") {
        this.#leaveCluster();
        this.#pos++;
        continue;
      }
      if (this.#clusterEnd === Infinity && !CLUSTER_CHILDREN.has(h.id)) {
        // An unknown-size Cluster ends at the first element that can't be its child.
        this.#leaveCluster();
        continue;
      }
      const body = this.#pos + h.headerLen;
      if (h.id === ID.BlockGroup) {
        this.#flushGroup();
        this.#groupEnd = h.unknownSize ? -1 : this.#at(body) + h.size;
        this.#pos = body;
        continue;
      }
      if (h.unknownSize) {
        this.#leaveCluster();
        this.#pos = body;
        continue;
      }
      if (h.id === ID.SimpleBlock || h.id === ID.Block) {
        const track = readVint(b, body, false);
        if (track === null) return;
        if (track === "bad" || !this.#tracks.has(track.value) || h.size > MAX_TEXT_BLOCK) {
          this.#advance(h.headerLen + h.size);
          continue;
        }
        if (body + h.size > b.length) return; // wait for the whole subtitle block
        const hdr = track.len + 3; // track vint + int16 timecode + flags
        if (h.size < hdr) {
          this.#advance(h.headerLen + h.size);
          continue;
        }
        const view = new DataView(b.buffer, b.byteOffset + body + track.len, 2);
        const start = (this.#clusterTime + view.getInt16(0)) * this.#scale;
        const data = b.slice(body + hdr, body + h.size);
        if (h.id === ID.SimpleBlock) {
          this.#onCue({ track: track.value, start, end: null, data });
        } else {
          this.#pending = { track: track.value, start, data };
        }
        this.#pos = body + h.size;
        continue;
      }
      if (h.id === ID.Timestamp || h.id === ID.BlockDuration) {
        if (h.size > 8) {
          // An integer can't be this long: corrupt. Skip it rather than buffer it.
          this.#advance(h.headerLen + h.size);
          continue;
        }
        if (body + h.size > b.length) return;
        const v = readUint(b.subarray(body, body + h.size));
        if (h.id === ID.Timestamp) this.#clusterTime = v;
        else this.#pendingDuration = v;
        this.#pos = body + h.size;
        continue;
      }
      this.#advance(h.headerLen + h.size);
    }
  }

  /**
   * Find the next Cluster and enter it. A match only counts if it is followed
   * by a Timestamp element (muxers write it first), which keeps the 4-byte
   * pattern from false-matching inside video payloads. Returns false when more
   * input is needed.
   */
  #seekCluster(): boolean {
    const b = this.#buf;
    for (;;) {
      const i = b.indexOf(CLUSTER_MAGIC[0]!, this.#pos);
      if (i < 0 || i + 4 > b.length) {
        // Keep a possible partial match at the tail for the next push.
        this.#pos = i < 0 ? Math.max(this.#pos, b.length - 3) : i;
        return false;
      }
      if (
        b[i + 1] !== CLUSTER_MAGIC[1] || b[i + 2] !== CLUSTER_MAGIC[2] ||
        b[i + 3] !== CLUSTER_MAGIC[3]
      ) {
        this.#pos = i + 1;
        continue;
      }
      const cluster = readElementHeader(b, i);
      if (cluster === null) {
        this.#pos = i;
        return false;
      }
      const bodyAt = cluster === "bad" ? -1 : i + cluster.headerLen;
      // ffmpeg writes a CRC-32 (BF 84 xx xx xx xx) before the Timestamp.
      let tsAt = bodyAt;
      if (tsAt >= 0 && tsAt < b.length && b[tsAt] === 0xbf) {
        if (tsAt + 1 >= b.length) {
          this.#pos = i;
          return false;
        }
        tsAt = b[tsAt + 1] === 0x84 ? tsAt + 6 : -1;
      }
      const ts = tsAt < 0 ? "bad" : readElementHeader(b, tsAt);
      if (ts === null) {
        this.#pos = i;
        return false;
      }
      if (cluster === "bad" || ts === "bad" || ts.id !== ID.Timestamp || ts.size > 8) {
        this.#pos = i + 1;
        continue;
      }
      this.#inCluster = true;
      this.#clusterEnd = cluster.unknownSize ? Infinity : this.#at(bodyAt) + cluster.size;
      this.#clusterTime = 0;
      this.#pos = tsAt; // the Timestamp is parsed as the first child
      return true;
    }
  }
}

// ---- cue text ----

/** Longest cue kept, in bytes: a subtitle line is a sentence or two. */
export const MAX_CUE_BYTES = 4096;

/** zlib-inflate, stopping once `limit` bytes are out (no decompression bombs). */
async function inflateCapped(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([new Uint8Array(data)]).stream()
    .pipeThrough(new DecompressionStream("deflate")).getReader();
  const out = new Uint8Array(limit);
  let n = 0;
  try {
    while (n < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, limit - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.subarray(0, n);
}

/**
 * Turn a raw block into cue text for the track's codec. Async because zlib
 * content compression is undone with DecompressionStream.
 */
export async function cueText(track: SubtitleTrack, data: Uint8Array): Promise<string> {
  let bytes = data;
  if (track.compression?.algo === 3) {
    bytes = new Uint8Array(track.compression.settings.length + data.length);
    bytes.set(track.compression.settings);
    bytes.set(data, track.compression.settings.length);
  } else if (track.compression?.algo === 0) {
    bytes = await inflateCapped(data, MAX_CUE_BYTES);
  }
  let text = utf8.decode(bytes.subarray(0, MAX_CUE_BYTES));
  if (track.codec === "S_TEXT/ASS" || track.codec === "S_TEXT/SSA") {
    // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    const parts = text.split(",");
    text = parts.length > 8 ? parts.slice(8).join(",") : text;
    text = text.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
  }
  return text.trim();
}
