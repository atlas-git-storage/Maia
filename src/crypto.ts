/**
 * Crypto for the atlas read path. Verified against atlas source:
 *   - ChaCha20-Poly1305 AEAD, 256-bit key.
 *   - Nonce is FIXED at 12 zero bytes. No associated data.
 *   - Stored asset bytes = ciphertext || 16-byte Poly1305 tag.
 *   - chunk_id = blake3 over the WHOLE stored asset (ciphertext||tag, i.e. what
 *     atlas calls the "ciphertext"), 32-byte digest, lowercase hex.
 *
 * The fixed nonce is safe here because atlas uses convergent encryption: each
 * chunk's key is derived per-plaintext, so no (key, nonce) pair ever repeats.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase64 } from "@std/encoding/base64";
import { decodeHex, encodeHex } from "@std/encoding/hex";
import { BadVaultError, HttpError } from "./errors.ts";

const KEY_LEN = 32;
const CHUNK_ID_LEN = 32;
const VAULT_SECRET_LEN = 32;
/** Poly1305 tag appended to every stored asset: plaintext length = asset size - TAG_LEN. */
const TAG_LEN = 16;
/** atlas: `_FIXED_NONCE = b"\x00" * 12`. */
const FIXED_NONCE = new Uint8Array(12);

/**
 * Decrypt one chunk's stored asset bytes (ciphertext||tag) with its 32-byte key.
 * Throws BadVaultError if the key is the wrong length or the AEAD tag fails to
 * authenticate (tampered/corrupt ciphertext, or wrong key).
 */
export function decryptChunk(key: Uint8Array, asset: Uint8Array): Uint8Array {
  if (key.length !== KEY_LEN) {
    throw new BadVaultError(`chunk key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  try {
    return chacha20poly1305(key, FIXED_NONCE).decrypt(asset);
  } catch (e) {
    throw new BadVaultError(`chunk decryption/authentication failed: ${(e as Error).message}`);
  }
}

/** Compute the chunk_id (blake3 of the whole stored asset, ciphertext||tag) as lowercase hex. */
export function chunkIdHex(asset: Uint8Array): string {
  return encodeHex(blake3(asset, { dkLen: CHUNK_ID_LEN }));
}

/**
 * Decode a 64-char lowercase-hex string into 32 raw bytes, validating length.
 * Used on the ROOT manifest pointer, where cid/key are HEX (unlike manifest
 * entries, where they are already raw bytes).
 */
export function hexToKey(hex: string): Uint8Array {
  const bytes = hexToBytes(hex, "key");
  if (bytes.length !== KEY_LEN) {
    throw new BadVaultError(`hex key must decode to ${KEY_LEN} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Decode a hex chunk_id into 32 raw bytes, validating length. */
export function hexToCid(hex: string): Uint8Array {
  const bytes = hexToBytes(hex, "chunk_id");
  if (bytes.length !== CHUNK_ID_LEN) {
    throw new BadVaultError(
      `hex chunk_id must decode to ${CHUNK_ID_LEN} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function hexToBytes(hex: string, what: string): Uint8Array {
  try {
    return decodeHex(hex);
  } catch (e) {
    throw new BadVaultError(`invalid hex ${what}: ${(e as Error).message}`);
  }
}

/** Encode raw bytes as lowercase hex (e.g. a chunk_id for asset lookup). */
export function bytesToHex(bytes: Uint8Array): string {
  return encodeHex(bytes);
}

/**
 * Decode the atlas vault secret (the `vault_secret:` line of the recovery
 * card): standard base64 of exactly 32 bytes.
 */
export function parseVaultSecret(b64: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = decodeBase64(b64);
  } catch (e) {
    throw new Error(`vault secret is not valid base64: ${(e as Error).message}`);
  }
  if (raw.length !== VAULT_SECRET_LEN) {
    throw new Error(`vault secret must decode to ${VAULT_SECRET_LEN} bytes, got ${raw.length}`);
  }
  return raw;
}

// ---- Sealed ROOT pointers (atlas >= 0.2.0, `crypto.seal_pointer`) ----
//
// sealed = "sealed1:" + base64(nonce(12) || ciphertext || tag(16)), encrypted
// with ChaCha20-Poly1305 under HKDF-SHA256(secret, salt=none,
// info="atlas/root-pointer/v1"), AAD = "atlas-pointer|<vault_id>|<field>".
// Anything without the prefix is a legacy (pre-0.2.0) plaintext pointer and is
// returned unchanged, so old vaults stay readable without the secret.

const SEALED_PREFIX = "sealed1:";
const POINTER_NONCE_LEN = 12;
const POINTER_KEY_INFO = new TextEncoder().encode("atlas/root-pointer/v1");

/** What's needed to open sealed pointers. Absent => only legacy vaults are readable. */
export interface PointerSealing {
  vaultId: string;
  /** Raw 32-byte vault secret. */
  secret: Uint8Array;
}

export function isSealedPointer(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/**
 * Reverse atlas's `seal_pointer`. Legacy pointers pass through. A sealed
 * pointer without a configured secret is a deployment misconfiguration (500);
 * one that fails authentication means a wrong secret or a tampered ROOT (502).
 */
export function openPointer(
  sealing: PointerSealing | undefined,
  value: string,
  field: string,
): string {
  if (!isSealedPointer(value)) return value;
  if (!sealing) {
    throw new HttpError(
      500,
      "vault uses sealed ROOT pointers (atlas >= 0.2.0); set ATLAS_VAULT_SECRET",
    );
  }
  let raw: Uint8Array;
  try {
    raw = decodeBase64(value.slice(SEALED_PREFIX.length));
  } catch (e) {
    throw new BadVaultError(`sealed pointer is not valid base64: ${(e as Error).message}`);
  }
  if (raw.length < POINTER_NONCE_LEN + TAG_LEN) {
    throw new BadVaultError("sealed pointer is too short");
  }
  const key = hkdf(sha256, sealing.secret, undefined, POINTER_KEY_INFO, KEY_LEN);
  const aad = new TextEncoder().encode(`atlas-pointer|${sealing.vaultId}|${field}`);
  let pt: Uint8Array;
  try {
    pt = chacha20poly1305(key, raw.subarray(0, POINTER_NONCE_LEN), aad)
      .decrypt(raw.subarray(POINTER_NONCE_LEN));
  } catch {
    throw new BadVaultError(
      "sealed ROOT pointer failed authentication (wrong ATLAS_VAULT_SECRET, or ROOT was tampered with)",
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(pt);
}

export { CHUNK_ID_LEN, KEY_LEN, TAG_LEN };
