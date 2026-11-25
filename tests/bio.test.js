import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, randomBytes as nodeRandom } from 'node:crypto';
import { dbClearAll, dbGet } from '../src/db.js';
import * as bio from '../src/bio.js';
import * as vault from '../src/vault.js';
import { randomBytes } from '../src/crypto.js';

const FAST = { m: 1024, t: 1, p: 1 };
const PW = 'correct horse battery staple';

// Fake platform authenticator: PRF(salt) = HMAC(secret, salt), like a real CTAP hmac-secret.
function fakeAuthenticator({ prf = true, secret = nodeRandom(32), cancel = false } = {}) {
  const credId = nodeRandom(16);
  const ext = (res) => () => res;
  return {
    secret,
    creds: {
      async create() {
        if (cancel) throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
        return { rawId: credId.buffer.slice(credId.byteOffset, credId.byteOffset + 16), getClientExtensionResults: ext(prf ? { prf: { enabled: true } } : {}) };
      },
      async get({ publicKey }) {
        if (cancel) throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
        const salt = Buffer.from(publicKey.extensions.prf.eval.first);
        const out = createHmac('sha256', secret).update(salt).digest();
        return { getClientExtensionResults: ext({ prf: { results: { first: out.buffer.slice(out.byteOffset, out.byteOffset + 32) } } }) };
      },
    },
  };
}
const opts = (a) => ({ creds: a.creds, rpId: 'localhost' });

beforeEach(async () => {
  vault.lock();
  await dbClearAll();
});

describe('fingerprint unlock (WebAuthn PRF)', () => {
  it('enrol -> lock -> unlock with fingerprint recovers the same vault', async () => {
    const a = fakeAuthenticator();
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'Bank', password: 'pw-123' });
    const raw = vault.getVaultKeyRaw();
    await bio.enroll(raw, opts(a));
    raw.fill(0);
    expect(await bio.isEnrolled()).toBe(true);

    vault.lock();
    const key = await bio.unlockKey(opts(a));
    await vault.unlockWithVaultKey(key);
    expect(vault.listEntries()[0]).toMatchObject({ title: 'Bank', password: 'pw-123' });
  });

  it('never stores the vault key in the clear', async () => {
    const a = fakeAuthenticator();
    await vault.createVault(PW, FAST);
    const raw = vault.getVaultKeyRaw();
    const copy = Buffer.from(raw);
    await bio.enroll(raw, opts(a));
    const rec = await dbGet('bio');
    const blob = Buffer.concat([Buffer.from(rec.wrapped.ct), Buffer.from(rec.credId), Buffer.from(rec.prfSalt), Buffer.from(rec.wrapped.iv)]);
    expect(blob.includes(copy)).toBe(false);
    expect(JSON.stringify(Object.keys(rec).sort())).toBe(JSON.stringify(['created', 'credId', 'prfSalt', 'v', 'wrapped']));
  });

  it('a different authenticator secret cannot unwrap the key', async () => {
    const a = fakeAuthenticator();
    await vault.createVault(PW, FAST);
    await bio.enroll(vault.getVaultKeyRaw(), opts(a));
    vault.lock();
    const imposter = fakeAuthenticator();
    await expect(bio.unlockKey(opts(imposter))).rejects.toMatchObject({ name: 'BioError', code: 'failed' });
    expect(vault.isUnlocked()).toBe(false);
  });

  it('tampered wrapped key is rejected', async () => {
    const a = fakeAuthenticator();
    await vault.createVault(PW, FAST);
    await bio.enroll(vault.getVaultKeyRaw(), opts(a));
    const rec = await dbGet('bio');
    rec.wrapped.ct[0] ^= 1;
    await (await import('../src/db.js')).dbSet('bio', rec);
    await expect(bio.unlockKey(opts(a))).rejects.toMatchObject({ code: 'failed' });
  });

  it('refuses to enrol without PRF support and stores nothing', async () => {
    const a = fakeAuthenticator({ prf: false });
    await vault.createVault(PW, FAST);
    await expect(bio.enroll(vault.getVaultKeyRaw(), opts(a))).rejects.toMatchObject({ code: 'unsupported' });
    expect(await bio.isEnrolled()).toBe(false);
  });

  it('cancelled prompt is reported as cancelled', async () => {
    const a = fakeAuthenticator({ cancel: true });
    await vault.createVault(PW, FAST);
    await expect(bio.enroll(vault.getVaultKeyRaw(), opts(a))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('master password still works, and disable removes fingerprint access', async () => {
    const a = fakeAuthenticator();
    await vault.createVault(PW, FAST);
    await bio.enroll(vault.getVaultKeyRaw(), opts(a));
    await vault.changeMasterPassword(PW, 'another long passphrase!', FAST); // vault key unchanged
    vault.lock();
    await vault.unlockWithVaultKey(await bio.unlockKey(opts(a)));
    vault.lock();
    await vault.unlock('another long passphrase!');
    await bio.disable();
    expect(await bio.isEnrolled()).toBe(false);
    await expect(bio.unlockKey(opts(a))).rejects.toThrow();
  });

  it('restoring a backup clears fingerprint enrolment', async () => {
    const a = fakeAuthenticator();
    await vault.createVault(PW, FAST);
    await bio.enroll(vault.getVaultKeyRaw(), opts(a));
    const backup = JSON.parse(JSON.stringify(await vault.exportBackup()));
    await vault.restoreBackup(backup, PW);
    expect(await bio.isEnrolled()).toBe(false);
  });

  it('wrong vault key is rejected by the data check', async () => {
    await vault.createVault(PW, FAST);
    vault.lock();
    await expect(vault.unlockWithVaultKey(randomBytes(32))).rejects.toMatchObject({ name: 'DecryptError' });
    expect(vault.isUnlocked()).toBe(false);
  });

  it('3-day master-password policy', async () => {
    const now = Date.now(), day = 86400000;
    expect(bio.masterRequired(0, now)).toBe(true);
    expect(bio.masterRequired(now - 2.9 * day, now)).toBe(false);
    expect(bio.masterRequired(now - 3.1 * day, now)).toBe(true);
    await vault.createVault(PW, FAST);
    expect(bio.masterRequired(await vault.getLastMasterUnlock())).toBe(false);
    vault.lock();
    const before = await vault.getLastMasterUnlock();
    await new Promise((r) => setTimeout(r, 5));
    await vault.unlock(PW);
    expect(await vault.getLastMasterUnlock()).toBeGreaterThan(before);
  });
});
