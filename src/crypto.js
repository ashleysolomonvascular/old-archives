// Crypto primitives. No hand-rolled crypto: Argon2id (hash-wasm) + AES-256-GCM (Web Crypto).
import { argon2id } from 'hash-wasm';

export const KDF_DEFAULTS = Object.freeze({ m: 65536, t: 3, p: 1 }); // 64 MB, 3 iterations
const enc = new TextEncoder();
const dec = new TextDecoder();

export class DecryptError extends Error {
  constructor(msg = 'Decryption failed') {
    super(msg);
    this.name = 'DecryptError';
  }
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function wipe(buf) {
  if (buf && buf.fill) buf.fill(0);
}

// Sanity bounds so a corrupted/tampered header can't make the KDF trivial or hang the device.
function checkKdf({ m, t, p }) {
  if (!(m >= 8 && m <= 1048576 && t >= 1 && t <= 20 && p >= 1 && p <= 8)) {
    throw new Error('Invalid KDF parameters');
  }
}

/** Derive a 32-byte raw key from a password (string) and salt. Caller should wipe() the result. */
export async function deriveRaw(password, salt, params = KDF_DEFAULTS) {
  checkKdf(params);
  return argon2id({
    password: enc.encode(password.normalize('NFKC')),
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  });
}

/** Import raw bytes as a non-extractable AES-GCM key. */
export function importKey(raw, usages = ['encrypt', 'decrypt']) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

export function newVaultKeyRaw() {
  return randomBytes(32);
}

/** AES-GCM encrypt bytes -> {iv, ct}. Fresh 12-byte IV every call. `aad` binds context. */
export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes),
  );
  return { iv, ct };
}

export async function decryptBytes(key, { iv, ct }, aad) {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, ct),
    );
  } catch {
    throw new DecryptError();
  }
}

export async function encryptJson(key, obj, aad) {
  return encryptBytes(key, enc.encode(JSON.stringify(obj)), aad);
}

export async function decryptJson(key, blob, aad) {
  const bytes = await decryptBytes(key, blob, aad);
  try {
    return JSON.parse(dec.decode(bytes));
  } finally {
    wipe(bytes);
  }
}

// base64 helpers for the export file
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
