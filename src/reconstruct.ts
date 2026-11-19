/**
 * Stream a file (or a byte range of it) by decrypting its chunks one at a time.
 *
 * Planning: each chunk's plaintext length is known up front from its asset size
 * (`ChunkReader.chunkLength`), so a range is mapped to exactly the chunks that
 * overlap it — a seek to 90% of a video fetches only the chunk containing that
 * offset, never the 90% before it. The plan is computed before the response
 * headers are sent, so a vault whose chunk sizes disagree with the manifest's
 * `s` fails as a clean 502 instead of a truncated body.
 *
 * Streaming: ChaCha20-Poly1305 is one-shot, so a whole chunk is fetched and
 * authenticated before any of its bytes go out. To hide that latency, the next
 * chunk is fetched while the current one is being sent (read-ahead of one).
 * The ReadableStream is pull-based, so memory stays bounded at ~2 chunks per
 * stream regardless of file size.
 */

import type { ChunkRef } from "./types.ts";
import { BadVaultError } from "./errors.ts";

export interface ChunkReader {
  /** Plaintext length of a chunk, without fetching it. */
  chunkLength(ref: ChunkRef): Promise<number>;
  /** Fetch + decrypt a chunk. */
  readChunk(ref: ChunkRef): Promise<Uint8Array>;
}

/** One chunk's contribution to a range: plaintext bytes [from, to) of `ref`. */
export interface Piece {
  ref: ChunkRef;
  /** Expected plaintext length of the whole chunk (verified after decrypt). */
  length: number;
  from: number;
  to: number;
}

/**
 * Map the inclusive byte range [start, end] of a file of `size` bytes onto its
 * chunks. Throws BadVaultError if the chunk lengths don't add up to `size`.
 * Assumes 0 <= start <= end < size (caller resolves Range first).
 */
export async function planRange(
  reader: ChunkReader,
  chunks: ChunkRef[],
  size: number,
  start: number,
  end: number,
): Promise<Piece[]> {
  const lengths = await Promise.all(chunks.map((c) => reader.chunkLength(c)));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total !== size) {
    throw new BadVaultError(`file chunks hold ${total} bytes but the manifest says ${size}`);
  }
  const pieces: Piece[] = [];
  let offset = 0; // plaintext offset of the start of chunk i
  for (let i = 0; i < chunks.length && offset <= end; i++) {
    const length = lengths[i]!;
    const chunkEnd = offset + length - 1; // inclusive
    if (chunkEnd >= start) {
      pieces.push({
        ref: chunks[i]!,
        length,
        from: Math.max(start, offset) - offset,
        to: Math.min(end, chunkEnd) - offset + 1,
      });
    }
    offset += length;
  }
  return pieces;
}

/** Emit the planned pieces in order, fetching one chunk ahead. */
export function rangeStream(reader: ChunkReader, pieces: Piece[]): ReadableStream<Uint8Array> {
  let i = 0;
  let ahead: Promise<Uint8Array> | null = null;

  const fetchPiece = (p: Piece): Promise<Uint8Array> => {
    const pending = reader.readChunk(p.ref);
    // A read-ahead may be abandoned (client disconnects); never let its failure
    // surface as an unhandled rejection. Awaiting `pending` still sees errors.
    pending.catch(() => {});
    return pending;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const piece = pieces[i];
        if (!piece) return controller.close();
        const current = ahead ?? fetchPiece(piece);
        const next = pieces[i + 1];
        ahead = next ? fetchPiece(next) : null;
        const pt = await current;
        if (pt.length !== piece.length) {
          throw new BadVaultError(
            `chunk decrypted to ${pt.length} bytes, expected ${piece.length} from its asset size`,
          );
        }
        controller.enqueue(pt.subarray(piece.from, piece.to));
        i++;
        if (i >= pieces.length) controller.close();
      } catch (e) {
        // Headers are already sent; log it and error the body so the client
        // connection aborts instead of hanging.
        console.error("stream error:", e instanceof Error ? e.message : String(e));
        controller.error(e);
      }
    },
    cancel() {
      ahead = null;
    },
  }, { highWaterMark: 0 });
}
