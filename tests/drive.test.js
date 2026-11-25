import { describe, it, expect, beforeEach } from 'vitest';
import { dbClearAll, dbGet } from '../src/db.js';
import * as vault from '../src/vault.js';
import * as drive from '../src/drive.js';

const FAST = { m: 1024, t: 1, p: 1 };
const PW = 'correct horse battery staple';

// Minimal in-memory Google Drive implementing just the calls drive.js makes.
function fakeDrive({ validToken = 'good' } = {}) {
  const files = new Map(); // id -> {id,name,parents,mimeType,content,modifiedTime}
  let n = 0;
  const log = [];
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o, text: async () => JSON.stringify(o) });
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.Authorization;
    log.push(`${init.method || 'GET'} ${u.pathname}`);
    if (auth !== `Bearer ${validToken}`) return json({}, 401);
    const m = u.pathname.match(/^\/(?:upload\/)?drive\/v3\/files(?:\/(.+))?$/);
    if (!m) return json({}, 404);
    const id = m[1];
    if (!id && (init.method || 'GET') === 'GET') {
      const q = u.searchParams.get('q');
      const name = /name='([^']*)'/.exec(q)[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const isFolder = q.includes('google-apps.folder');
      let list = [...files.values()].filter((f) => f.name === name && !f.trashed && (!isFolder || f.mimeType.includes('folder')) && (!parent || f.parents?.includes(parent)));
      list.sort((a, b) => b.modifiedTime - a.modifiedTime);
      return json({ files: list.slice(0, 1).map(({ id }) => ({ id })) });
    }
    if (!id && init.method === 'POST' && u.pathname.startsWith('/upload')) {
      const [, meta, content] = /Content-Type: application\/json; charset=UTF-8\r\n\r\n(.*?)\r\n--[^\r]*\r\nContent-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/.exec(init.body);
      const f = { id: `f${++n}`, ...JSON.parse(meta), content, modifiedTime: ++n };
      files.set(f.id, f);
      return json({ id: f.id });
    }
    if (!id && init.method === 'POST') {
      const f = { id: `d${++n}`, ...JSON.parse(init.body), modifiedTime: ++n };
      files.set(f.id, f);
      return json({ id: f.id });
    }
    const f = files.get(id);
    if (!f) return json({}, 404);
    if (init.method === 'PATCH') {
      f.content = /Content-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/.exec(init.body)[1];
      f.modifiedTime = ++n;
      return json({ id });
    }
    if (u.searchParams.get('alt') === 'media') return { ok: true, status: 200, text: async () => f.content };
    return json({}, 404);
  };
  return { impl, files, log };
}

beforeEach(async () => {
  vault.lock();
  await dbClearAll();
  drive.clearToken();
});

describe('drive backup', () => {
  it('first backup creates folder + file; later backups update the same file', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'a', password: 'secret-pw-1' });
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    const folders = [...d.files.values()].filter((f) => f.mimeType.includes('folder'));
    const backups = [...d.files.values()].filter((f) => f.name === drive.FILE_NAME);
    expect(folders).toHaveLength(1);
    expect(backups).toHaveLength(1);
    expect(backups[0].parents).toEqual([folders[0].id]);
    const first = backups[0].content;

    await vault.saveEntry({ title: 'b', password: 'secret-pw-2' });
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    expect([...d.files.values()].filter((f) => f.name === drive.FILE_NAME)).toHaveLength(1); // updated, not duplicated
    expect([...d.files.values()].find((f) => f.name === drive.FILE_NAME).content).not.toBe(first);
    const rec = await drive.getRecord();
    expect(rec.connected).toBe(true);
    expect(rec.dirty).toBe(false);
  });

  it('only ciphertext reaches Drive (no plaintext secrets)', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'MyBankTitle', username: 'ash@example.com', password: 'secret-pw-1' });
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    const all = JSON.stringify([...d.files.values()]);
    for (const s of ['secret-pw-1', 'MyBankTitle', 'ash@example.com', PW]) expect(all).not.toContain(s);
  });

  it('can back up while the vault is locked (ciphertext only)', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    vault.lock();
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    expect((await drive.getRecord()).connected).toBe(true);
  });

  it('restore on a fresh install: download latest -> restoreBackup', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'Gmail', password: 'pw-gm' });
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });

    vault.lock();
    await dbClearAll(); // new phone / reinstall
    const obj = await drive.downloadLatest({ token: 'good', fetchImpl: d.impl });
    await expect(vault.restoreBackup(obj, 'wrong password!!')).rejects.toMatchObject({ name: 'DecryptError' });
    await vault.restoreBackup(obj, PW);
    expect(vault.listEntries()[0]).toMatchObject({ title: 'Gmail', password: 'pw-gm' });
  });

  it('a tampered Drive file is rejected on restore', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await vault.saveEntry({ title: 'x', password: 'y' });
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    const f = [...d.files.values()].find((x) => x.name === drive.FILE_NAME);
    const o = JSON.parse(f.content);
    const b = Buffer.from(o.data.ct, 'base64'); b[0] ^= 1; o.data.ct = b.toString('base64');
    f.content = JSON.stringify(o);
    vault.lock(); await dbClearAll();
    const obj = await drive.downloadLatest({ token: 'good', fetchImpl: d.impl });
    await expect(vault.restoreBackup(obj, PW)).rejects.toMatchObject({ name: 'DecryptError' });
    expect(await vault.isInitialised()).toBe(false);
  });

  it('reports an expired/invalid token as an auth error and clears it', async () => {
    const d = fakeDrive({ validToken: 'good' });
    await vault.createVault(PW, FAST);
    drive.setToken('stale', 3600);
    await expect(drive.backup(vault.exportBackup, { token: 'stale', fetchImpl: d.impl })).rejects.toMatchObject({ code: 'auth' });
    expect(drive.getToken()).toBeNull();
    await expect(drive.backup(vault.exportBackup, { token: null, fetchImpl: d.impl })).rejects.toMatchObject({ code: 'auth' });
  });

  it('recovers if the file/folder was deleted on Drive', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    d.files.clear(); // user emptied their Drive
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    expect([...d.files.values()].filter((f) => f.name === drive.FILE_NAME)).toHaveLength(1);
  });

  it('restoring a backup keeps the Drive link on this device', async () => {
    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    const link = await dbGet('drive');
    const obj = JSON.parse(JSON.stringify(await vault.exportBackup()));
    await vault.restoreBackup(obj, PW);
    expect(await dbGet('drive')).toEqual(link);
  });

  it('reports "no backup" cleanly', async () => {
    const d = fakeDrive();
    await expect(drive.downloadLatest({ token: 'good', fetchImpl: d.impl })).rejects.toMatchObject({ code: 'notfound' });
  });

  it('dirty tracking and weekly schedule', async () => {
    const now = Date.now(), day = 86400000;
    expect(drive.isDue({ connected: false, dirty: true }, now)).toBe(false);
    expect(drive.isDue({ connected: true, dirty: true, lastBackup: now }, now)).toBe(true);
    expect(drive.isDue({ connected: true, dirty: false, lastBackup: now - 6 * day }, now)).toBe(false);
    expect(drive.isDue({ connected: true, dirty: false, lastBackup: now - 8 * day }, now)).toBe(true);
    expect(drive.isDue({ connected: true, dirty: false }, now)).toBe(true);

    const d = fakeDrive();
    await vault.createVault(PW, FAST);
    await drive.markDirty(); // not connected: ignored
    expect((await drive.getRecord()).dirty).toBe(false);
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    await drive.markDirty();
    expect((await drive.getRecord()).dirty).toBe(true);
    await drive.backup(vault.exportBackup, { token: 'good', fetchImpl: d.impl });
    expect((await drive.getRecord()).dirty).toBe(false);
  });

  it('onDataChange fires for entry edits but not lock/unlock', async () => {
    let n = 0;
    const off = vault.onDataChange(() => n++);
    await vault.createVault(PW, FAST);
    vault.lock(); await vault.unlock(PW);
    expect(n).toBe(0);
    const e = await vault.saveEntry({ title: 'a' });
    await vault.deleteEntry(e.id);
    expect(n).toBe(2);
    off();
  });
});

describe('oauth redirect', () => {
  const sess = {};
  beforeEach(() => {
    globalThis.sessionStorage = { getItem: (k) => sess[k] ?? null, setItem: (k, v) => { sess[k] = v; }, removeItem: (k) => { delete sess[k]; } };
    for (const k of Object.keys(sess)) delete sess[k];
  });

  it('builds a drive.file-only auth URL', () => {
    const u = new URL(drive.buildAuthUrl({ clientId: 'cid', redirectUri: 'https://x.github.io/old-archives/', state: 's1' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(u.searchParams.get('response_type')).toBe('token');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('startAuth stores state+pending; handleRedirect validates state, stores token, scrubs the URL', () => {
    let target;
    drive.startAuth('connect', { clientId: 'cid', redirectUri: 'https://x/', navigate: (u) => { target = u; } });
    const state = new URL(target).searchParams.get('state');
    expect(state.length).toBeGreaterThan(10);
    let scrubbed;
    const loc = { hash: `#access_token=tok123&token_type=Bearer&expires_in=3599&scope=x&state=${state}`, pathname: '/old-archives/', search: '' };
    const pending = drive.handleRedirect(loc, { replaceState: (a, b, url) => { scrubbed = url; } });
    expect(pending).toBe('connect');
    expect(drive.getToken()).toBe('tok123');
    expect(scrubbed).toBe('/old-archives/');
  });

  it('rejects a wrong state (CSRF) and declined consent', () => {
    drive.startAuth('backup', { clientId: 'c', redirectUri: 'https://x/', navigate: () => {} });
    const hist = { replaceState() {} };
    expect(() => drive.handleRedirect({ hash: '#access_token=evil&expires_in=3600&state=nope', pathname: '/', search: '' }, hist)).toThrow(/state/);
    expect(drive.getToken()).toBeNull();
    drive.startAuth('backup', { clientId: 'c', redirectUri: 'https://x/', navigate: () => {} });
    const st = sess['oa.state'];
    expect(() => drive.handleRedirect({ hash: `#error=access_denied&state=${st}`, pathname: '/', search: '' }, hist)).toThrow(/declined/);
  });

  it('ignores ordinary page loads', () => {
    expect(drive.handleRedirect({ hash: '', pathname: '/', search: '' }, { replaceState() {} })).toBeNull();
  });

  it('tokens expire', () => {
    const t0 = Date.now();
    drive.setToken('t', 3600, t0);
    expect(drive.getToken(t0 + 3000 * 1000)).toBe('t');
    expect(drive.getToken(t0 + 3600 * 1000)).toBeNull();
  });
});
