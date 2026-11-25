// Google Drive backup. Scope: drive.file only (the app can see only files it created).
// Auth: plain OAuth 2.0 redirect (implicit/token response) - no Google script is ever loaded, so the CSP
// stays script-src 'self'. Tokens last ~1 hour and are held in memory/sessionStorage only. What we upload is
// the already-encrypted backup object, so Google only ever sees ciphertext.
import { dbGet, dbSet, dbDel } from './db.js';
import { randomBytes, b64 } from './crypto.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_NAME = 'Old archives';
export const FILE_NAME = 'oa-backup.json';
export const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // weekly
const API = 'https://www.googleapis.com';

export class DriveError extends Error {
  constructor(msg, status, code) {
    super(msg);
    this.name = 'DriveError';
    this.status = status;
    this.code = code; // 'auth' | 'notfound' | 'http' | 'network'
  }
}

// ---- token + redirect auth ------------------------------------------------------------------
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
let memToken = null; // { token, exp }

export function setToken(token, expiresInSec, now = Date.now()) {
  memToken = { token, exp: now + (expiresInSec - 60) * 1000 }; // 60 s safety margin
  store.set('oa.tok', JSON.stringify(memToken));
}
export function getToken(now = Date.now()) {
  if (!memToken) {
    try { memToken = JSON.parse(store.get('oa.tok') || 'null'); } catch { memToken = null; }
  }
  return memToken && memToken.exp > now ? memToken.token : null;
}
export function clearToken() {
  memToken = null;
  store.del('oa.tok');
}

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: SCOPE,
    state, include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Send the user to Google. `pending` is what to do when they come back ('connect'|'backup'|'restore'). */
export function startAuth(pending, { clientId, redirectUri, navigate = (u) => location.assign(u) }) {
  const state = b64(randomBytes(16)).replace(/[^A-Za-z0-9]/g, '');
  store.set('oa.state', state);
  store.set('oa.pending', pending);
  navigate(buildAuthUrl({ clientId, redirectUri, state }));
}

/** Parse the URL fragment Google redirects back with. Returns {token, expiresIn} or throws. */
export function parseAuthHash(hash, expectedState) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (!p.has('access_token') && !p.has('error')) return null; // not an OAuth return
  if (!expectedState || p.get('state') !== expectedState) throw new DriveError('Sign-in state mismatch', 0, 'auth');
  if (p.get('error')) throw new DriveError(p.get('error') === 'access_denied' ? 'Google access was declined' : p.get('error'), 0, 'auth');
  return { token: p.get('access_token'), expiresIn: Number(p.get('expires_in') || 3600) };
}

/** Call at startup. Returns the pending action name if we just came back from Google, else null. */
export function handleRedirect(loc = location, hist = history) {
  let res;
  try {
    res = parseAuthHash(loc.hash, store.get('oa.state'));
  } finally {
    if (/access_token=|error=/.test(loc.hash)) hist.replaceState(null, '', loc.pathname + loc.search); // scrub token from URL
    store.del('oa.state');
  }
  if (!res) return null;
  setToken(res.token, res.expiresIn);
  const pending = store.get('oa.pending');
  store.del('oa.pending');
  return pending || 'backup';
}

// ---- Drive REST -----------------------------------------------------------------------------
async function call(fetchImpl, token, url, init = {}) {
  let r;
  try {
    r = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  } catch {
    throw new DriveError('Network error talking to Google Drive', 0, 'network');
  }
  if (r.status === 401 || r.status === 403) { clearToken(); throw new DriveError('Google sign-in expired', r.status, 'auth'); }
  if (r.status === 404) throw new DriveError('Not found on Drive', 404, 'notfound');
  if (!r.ok) throw new DriveError(`Drive error ${r.status}`, r.status, 'http');
  return r;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function multipartBody(metadata, content) {
  const boundary = 'oa' + b64(randomBytes(12)).replace(/[^A-Za-z0-9]/g, '');
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return { body, type: `multipart/related; boundary=${boundary}` };
}

export function driveApi(token, fetchImpl = (...a) => globalThis.fetch(...a)) {
  const f = (url, init) => call(fetchImpl, token, url, init);
  return {
    async findFolder() {
      const q = `name='${esc(FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const r = await f(`${API}/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
      return (await r.json()).files?.[0]?.id || null;
    },
    async createFolder() {
      const r = await f(`${API}/drive/v3/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      });
      return (await r.json()).id;
    },
    async findBackup(folderId) {
      const parent = folderId ? ` and '${esc(folderId)}' in parents` : '';
      const q = `name='${esc(FILE_NAME)}' and trashed=false${parent}`;
      const r = await f(`${API}/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '1' })}`);
      return (await r.json()).files?.[0] || null;
    },
    async createBackup(folderId, content) {
      const { body, type } = multipartBody({ name: FILE_NAME, parents: [folderId], mimeType: 'application/json' }, content);
      const r = await f(`${API}/upload/drive/v3/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': type }, body });
      return (await r.json()).id;
    },
    async updateBackup(fileId, content) {
      const { body, type } = multipartBody({}, content);
      await f(`${API}/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`, { method: 'PATCH', headers: { 'Content-Type': type }, body });
      return fileId;
    },
    async download(fileId) {
      const r = await f(`${API}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
      return r.text();
    },
  };
}

// ---- state kept on the phone ----------------------------------------------------------------
export const getRecord = async () => (await dbGet('drive')) || { connected: false, dirty: false };
const putRecord = (r) => dbSet('drive', r);
export const disconnect = async () => { await dbDel('drive'); clearToken(); };

export async function markDirty() {
  const r = await getRecord();
  if (r.connected) await putRecord({ ...r, dirty: true, changeSeq: (r.changeSeq || 0) + 1 });
}

/** True when a backup is due: connected and (unsaved changes, or last backup older than a week). */
export function isDue(rec, now = Date.now()) {
  return !!rec.connected && (rec.dirty || !rec.lastBackup || now - rec.lastBackup > BACKUP_MAX_AGE_MS);
}

let running = null;
/** Upload the encrypted backup object. Creates the folder/file on first run. Serialised. */
export function backup(exportFn, { token = getToken(), fetchImpl } = {}) {
  if (running) return running;
  running = (async () => {
    if (!token) throw new DriveError('Not signed in to Google', 401, 'auth');
    const api = driveApi(token, fetchImpl);
    const rec = await getRecord();
    const seqAtStart = rec.changeSeq || 0;
    const content = JSON.stringify(await exportFn());
    let { folderId, fileId } = rec;
    if (!folderId) folderId = (await api.findFolder()) || (await api.createFolder());
    try {
      if (!fileId) fileId = (await api.findBackup(folderId))?.id || null;
      fileId = fileId ? await api.updateBackup(fileId, content) : await api.createBackup(folderId, content);
    } catch (e) {
      if (e.code !== 'notfound') throw e;
      // file or folder was deleted on Drive: start again cleanly
      folderId = (await api.findFolder()) || (await api.createFolder());
      fileId = await api.createBackup(folderId, content);
    }
    const latest = await getRecord();
    await putRecord({
      ...latest, connected: true, folderId, fileId, lastBackup: Date.now(),
      dirty: (latest.changeSeq || 0) !== seqAtStart, // changed while uploading -> still dirty
    });
  })().finally(() => { running = null; });
  return running;
}

/** Fetch the newest backup the app can see (works on a fresh install with the same client ID). */
export async function downloadLatest({ token = getToken(), fetchImpl } = {}) {
  if (!token) throw new DriveError('Not signed in to Google', 401, 'auth');
  const api = driveApi(token, fetchImpl);
  const file = await api.findBackup(null);
  if (!file) throw new DriveError('No backup found in your Google Drive', 404, 'notfound');
  try {
    return JSON.parse(await api.download(file.id));
  } catch (e) {
    if (e instanceof SyntaxError) throw new DriveError('The backup file on Drive is damaged', 0, 'http');
    throw e;
  }
}
