import { describe, it, expect, beforeEach } from 'vitest';
import { dbClearAll, dbGet, dbSet } from '../src/db.js';
import * as vault from '../src/vault.js';
import { DecryptError } from '../src/crypto.js';

const FAST = { m: 1024, t: 1, p: 1 };
const PW = 'correct horse battery staple';

beforeEach(async () => {
  vault.lock();
  await dbClearAll();
});

describe('vault', () => {
  it('creates, locks, unlocks', async () => {
    expect(await vault.isInitialised()).toBe(false);
    await vault.createVault(PW, FAST);
    expect(vault.isUnlocked()).toBe(true);
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(() => vault.listEntries()).toThrow(/locked/);
    await vault.unlock(PW);
    expect(vault.isUnlocked()).toBe(true);
  });

  it('rejects a wrong master password', async () => {
    await vault.createVault(PW, FAST);
    vault.lock();
    await expect(vault.unlock('wrong password')).rejects.toBeInstanceOf(DecryptError);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('works with the real production KDF params (64 MB / 3 iterations)', async () => {
    await vault.createVault(PW);
    vault.lock();
    await vault.unlock(PW);
    expect((await dbGet('header')).kdf).toEqual({ m: 65536, t: 3, p: 1 });
  });

  it('persists entries across lock/unlock; CRUD works', async () => {
    await vault.createVault(PW, FAST);
    const e = await vault.saveEntry({ title: 'Bank', username: 'ash', password: 'p@ss', tags: ['Money', ' money ', 'bank'] });
    expect(e.tags).toEqual(['money', 'bank']);
    await vault.saveEntry({ ...e, title: 'Bank 2' });
    expect(vault.listEntries()).toHaveLength(1);
    vault.lock();
    await vault.unlock(PW);
    expect(vault.getEntry(e.id).title).toBe('Bank 2');
    expect(vault.getEntry(e.id).password).toBe('p@ss');
    await vault.deleteEntry(e.id);
    vault.lock();
    await vault.unlock(PW);
    expect(vault.listEntries()).toHaveLength(0);
  });

  it('never stores plaintext secrets at rest', async () => {
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'SecretTitle', password: 'SuperSecretPw123' });
    const dump = JSON.stringify([...(await dbGet('data')).ct], null, 0) + JSON.stringify(await dbGet('header'));
    const raw = Buffer.from((await dbGet('data')).ct).toString('latin1');
    expect(raw).not.toContain('SuperSecretPw123');
    expect(raw).not.toContain('SecretTitle');
    expect(dump).not.toContain('SuperSecretPw123');
  });

  it('detects tampering with stored data', async () => {
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'x', password: 'y' });
    vault.lock();
    const data = await dbGet('data');
    data.ct[3] ^= 0xff;
    await dbSet('data', data);
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(DecryptError);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('detects tampering with the wrapped key / KDF header', async () => {
    await vault.createVault(PW, FAST);
    vault.lock();
    const h = await dbGet('header');
    h.wrapped.ct[0] ^= 1;
    await dbSet('header', h);
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(DecryptError);
  });

  it('changes master password without re-encrypting data', async () => {
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'a', password: 'b' });
    const before = await dbGet('data');
    await expect(vault.changeMasterPassword('nope', 'new pass phrase here', FAST)).rejects.toBeInstanceOf(DecryptError);
    await vault.changeMasterPassword(PW, 'new pass phrase here', FAST);
    expect(await dbGet('data')).toEqual(before);
    vault.lock();
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(DecryptError);
    await vault.unlock('new pass phrase here');
    expect(vault.listEntries()[0].title).toBe('a');
  });

  it('backup export -> restore on a fresh install', async () => {
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'Gmail', username: 'me', password: 'pw1', tags: ['mail'] });
    const backup = JSON.parse(JSON.stringify(await vault.exportBackup())); // survive serialisation
    expect(JSON.stringify(backup)).not.toContain('pw1');

    vault.lock();
    await dbClearAll(); // "fresh install"
    expect(await vault.isInitialised()).toBe(false);

    await expect(vault.restoreBackup(backup, 'wrong')).rejects.toBeInstanceOf(DecryptError);
    expect(await vault.isInitialised()).toBe(false); // failed restore leaves nothing behind

    await vault.restoreBackup(backup, PW);
    expect(vault.listEntries()[0]).toMatchObject({ title: 'Gmail', password: 'pw1' });
    vault.lock();
    await vault.unlock(PW);
    expect(vault.listEntries()).toHaveLength(1);
  });

  it('rejects a tampered backup and keeps the existing vault', async () => {
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'keep me', password: 'x' });
    const backup = JSON.parse(JSON.stringify(await vault.exportBackup()));
    const bytes = Buffer.from(backup.data.ct, 'base64');
    bytes[0] ^= 1;
    backup.data.ct = bytes.toString('base64');
    await expect(vault.restoreBackup(backup, PW)).rejects.toBeInstanceOf(DecryptError);
    expect(vault.listEntries()[0].title).toBe('keep me');
    await expect(vault.restoreBackup({ app: 'nope' }, PW)).rejects.toThrow(/backup/);
  });
});
