import { describe, it, expect } from 'vitest';
import {
  KDF_DEFAULTS, DecryptError, deriveRaw, importKey, encryptJson, decryptJson, encryptBytes, decryptBytes, randomBytes,
} from '../src/crypto.js';

const FAST = { m: 1024, t: 1, p: 1 };

describe('crypto', () => {
  it('uses the specified default KDF params (64 MB, 3 iterations)', () => {
    expect(KDF_DEFAULTS).toEqual({ m: 65536, t: 3, p: 1 });
  });

  it('Argon2id is deterministic per (password, salt) and differs across either', async () => {
    const salt = randomBytes(16);
    const a = await deriveRaw('hunter2', salt, FAST);
    const b = await deriveRaw('hunter2', salt, FAST);
    const c = await deriveRaw('hunter3', salt, FAST);
    const d = await deriveRaw('hunter2', randomBytes(16), FAST);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
    expect(a.length).toBe(32);
  });

  it('round-trips JSON', async () => {
    const key = await importKey(randomBytes(32));
    const blob = await encryptJson(key, { hello: 'wörld', n: [1, 2, 3] }, 'ctx');
    expect(await decryptJson(key, blob, 'ctx')).toEqual({ hello: 'wörld', n: [1, 2, 3] });
  });

  it('uses a fresh IV each time', async () => {
    const key = await importKey(randomBytes(32));
    const a = await encryptBytes(key, new Uint8Array([1]), 'x');
    const b = await encryptBytes(key, new Uint8Array([1]), 'x');
    expect(a.iv).not.toEqual(b.iv);
    expect(a.iv.length).toBe(12);
  });

  it('rejects the wrong key', async () => {
    const k1 = await importKey(randomBytes(32));
    const k2 = await importKey(randomBytes(32));
    const blob = await encryptJson(k1, { a: 1 }, 'ctx');
    await expect(decryptJson(k2, blob, 'ctx')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects ciphertext tampering (GCM auth failure)', async () => {
    const key = await importKey(randomBytes(32));
    const blob = await encryptJson(key, { a: 1 }, 'ctx');
    blob.ct[0] ^= 1;
    await expect(decryptBytes(key, blob, 'ctx')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects IV tampering and AAD mismatch', async () => {
    const key = await importKey(randomBytes(32));
    const blob = await encryptJson(key, { a: 1 }, 'ctx');
    await expect(decryptBytes(key, { ...blob, iv: randomBytes(12) }, 'ctx')).rejects.toBeInstanceOf(DecryptError);
    await expect(decryptBytes(key, blob, 'other')).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects absurd KDF params', async () => {
    await expect(deriveRaw('x', randomBytes(16), { m: 1, t: 0, p: 1 })).rejects.toThrow();
  });
});
