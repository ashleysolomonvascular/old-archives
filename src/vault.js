// Vault: key hierarchy + encrypted storage.
//
//   master password --Argon2id(salt)--> master key --wraps--> random vault key --encrypts--> entries blob
//
// Only ciphertext, the salt/KDF params and non-secret settings are persisted. Keys live in memory
// only while unlocked and are wiped on lock().
import {
  KDF_DEFAULTS, DecryptError, randomBytes, wipe, deriveRaw, importKey, newVaultKeyRaw,
  encryptBytes, decryptBytes, encryptJson, decryptJson, b64, unb64,
} from './crypto.js';
import { dbGet, dbSetMany, dbSet, dbClearAll } from './db.js';

const VERSION = 1;
const AAD_DATA = 'oa:data:v1';
const aadKey = (kdf, salt) => `oa:vk:v1|${kdf.m},${kdf.t},${kdf.p}|${b64(salt)}`;

export const DEFAULT_SETTINGS = Object.freeze({ autoLockMin: 2 });

let session = null; // { raw: Uint8Array, key: CryptoKey, entries: Entry[] }
let writeChain = Promise.resolve();
const listeners = new Set();

export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* listener errors must not break saves */ } });

export const isUnlocked = () => session !== null;
export async function isInitialised() {
  return !!(await dbGet('header'));
}

function requireSession() {
  if (!session) throw new Error('Vault is locked');
  return session;
}

async function wrapVaultKey(masterRaw, vaultRaw, kdf, salt) {
  const mk = await importKey(masterRaw, ['encrypt']);
  return encryptBytes(mk, vaultRaw, aadKey(kdf, salt));
}

async function unwrapVaultKey(password, header) {
  const masterRaw = await deriveRaw(password, header.salt, header.kdf);
  try {
    const mk = await importKey(masterRaw, ['decrypt']);
    return await decryptBytes(mk, header.wrapped, aadKey(header.kdf, header.salt));
  } finally {
    wipe(masterRaw);
  }
}

async function openSession(vaultRaw, dataBlob) {
  const key = await importKey(vaultRaw);
  const entries = dataBlob ? (await decryptJson(key, dataBlob, AAD_DATA)).entries : [];
  return { raw: vaultRaw, key, entries };
}

export async function createVault(password, kdf = KDF_DEFAULTS) {
  if (await isInitialised()) throw new Error('Vault already exists');
  const salt = randomBytes(16);
  const masterRaw = await deriveRaw(password, salt, kdf);
  const vaultRaw = newVaultKeyRaw();
  let wrapped;
  try {
    wrapped = await wrapVaultKey(masterRaw, vaultRaw, kdf, salt);
  } finally {
    wipe(masterRaw);
  }
  const s = await openSession(vaultRaw, null);
  const data = await encryptJson(s.key, { entries: [] }, AAD_DATA);
  await dbSetMany({
    header: { v: VERSION, kdf: { ...kdf }, salt, wrapped, created: Date.now() },
    data,
    settings: { ...DEFAULT_SETTINGS },
  });
  session = s;
  emit();
}

/** Throws DecryptError on a wrong password (or tampered header/data). */
export async function unlock(password) {
  const header = await dbGet('header');
  if (!header) throw new Error('No vault');
  const vaultRaw = await unwrapVaultKey(password, header);
  try {
    session = await openSession(vaultRaw, await dbGet('data'));
  } catch (e) {
    wipe(vaultRaw);
    throw e;
  }
  emit();
}

export function lock() {
  if (session) {
    wipe(session.raw);
    session = null;
    emit();
  }
}

/** Verify a password without changing state (used for sensitive actions). */
export async function verifyPassword(password) {
  const header = await dbGet('header');
  const raw = await unwrapVaultKey(password, header);
  wipe(raw);
  return true;
}

// ---- entries -------------------------------------------------------------------------------

function persist() {
  const s = requireSession();
  const snapshot = s.entries;
  writeChain = writeChain.then(async () => {
    const blob = await encryptJson(s.key, { entries: snapshot }, AAD_DATA);
    await dbSet('data', blob);
  });
  return writeChain;
}

export const listEntries = () => requireSession().entries.slice();
export const getEntry = (id) => requireSession().entries.find((e) => e.id === id);

export async function saveEntry(input) {
  const s = requireSession();
  const now = Date.now();
  const clean = {
    title: (input.title || '').trim() || 'Untitled',
    username: input.username || '',
    password: input.password || '',
    url: (input.url || '').trim(),
    notes: input.notes || '',
    tags: [...new Set((input.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
  };
  const idx = input.id ? s.entries.findIndex((e) => e.id === input.id) : -1;
  let entry;
  if (idx >= 0) {
    entry = { ...s.entries[idx], ...clean, updated: now };
    s.entries = s.entries.map((e, i) => (i === idx ? entry : e));
  } else {
    entry = { id: crypto.randomUUID(), ...clean, created: now, updated: now };
    s.entries = [...s.entries, entry];
  }
  await persist();
  emit();
  return entry;
}

export async function deleteEntry(id) {
  const s = requireSession();
  s.entries = s.entries.filter((e) => e.id !== id);
  await persist();
  emit();
}

/** Bulk add (used by import). Returns number added. */
export async function addEntries(list) {
  const s = requireSession();
  const now = Date.now();
  const added = list.map((i) => ({
    id: crypto.randomUUID(),
    title: (i.title || '').trim() || 'Untitled',
    username: i.username || '',
    password: i.password || '',
    url: (i.url || '').trim(),
    notes: i.notes || '',
    tags: [...new Set((i.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
    created: now,
    updated: now,
  }));
  s.entries = [...s.entries, ...added];
  await persist();
  emit();
  return added.length;
}

// ---- settings (non-secret) -----------------------------------------------------------------

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await dbGet('settings')) || {}) };
}
export async function setSettings(patch) {
  await dbSet('settings', { ...(await getSettings()), ...patch });
}

// ---- master password change ----------------------------------------------------------------

/** Re-wraps the vault key under a new master key. Entries are not re-encrypted. */
export async function changeMasterPassword(oldPassword, newPassword, kdf = KDF_DEFAULTS) {
  const s = requireSession();
  const header = await dbGet('header');
  const check = await unwrapVaultKey(oldPassword, header); // throws DecryptError if wrong
  wipe(check);
  const salt = randomBytes(16);
  const masterRaw = await deriveRaw(newPassword, salt, kdf);
  let wrapped;
  try {
    wrapped = await wrapVaultKey(masterRaw, s.raw, kdf, salt);
  } finally {
    wipe(masterRaw);
  }
  await dbSet('header', { ...header, kdf: { ...kdf }, salt, wrapped });
}

// ---- encrypted backup file -----------------------------------------------------------------

/** Self-contained, still-encrypted snapshot. Needs the master password to restore. */
export async function exportBackup() {
  requireSession();
  await writeChain;
  const header = await dbGet('header');
  const data = await dbGet('data');
  return {
    app: 'old-archives',
    format: VERSION,
    exported: new Date().toISOString(),
    kdf: header.kdf,
    salt: b64(header.salt),
    wrapped: { iv: b64(header.wrapped.iv), ct: b64(header.wrapped.ct) },
    data: { iv: b64(data.iv), ct: b64(data.ct) },
  };
}

function parseBackup(obj) {
  if (!obj || obj.app !== 'old-archives' || obj.format !== VERSION) throw new Error('Not an Old archives backup');
  const kdf = { m: +obj.kdf.m, t: +obj.kdf.t, p: +obj.kdf.p };
  return {
    kdf,
    salt: unb64(obj.salt),
    wrapped: { iv: unb64(obj.wrapped.iv), ct: unb64(obj.wrapped.ct) },
    data: { iv: unb64(obj.data.iv), ct: unb64(obj.data.ct) },
  };
}

/**
 * Replace local vault with a backup. Verifies the password against the backup first, so a wrong
 * password or a tampered file leaves the existing vault untouched. Leaves the vault unlocked.
 */
export async function restoreBackup(obj, password) {
  const b = parseBackup(obj);
  const vaultRaw = await unwrapVaultKey(password, b);
  let s;
  try {
    s = await openSession(vaultRaw, b.data);
  } catch (e) {
    wipe(vaultRaw);
    throw e;
  }
  await writeChain;
  await dbClearAll();
  await dbSetMany({
    header: { v: VERSION, kdf: b.kdf, salt: b.salt, wrapped: b.wrapped, created: Date.now() },
    data: b.data,
    settings: { ...DEFAULT_SETTINGS },
  });
  if (session) wipe(session.raw);
  session = s;
  emit();
}

export { DecryptError };
