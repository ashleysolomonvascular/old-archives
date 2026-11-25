// Minimal IndexedDB key/value wrapper. Only ciphertext and non-secret settings are ever stored here.
const DB_NAME = 'old-archives';
const STORE = 'kv';

let dbp;
function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const dbGet = (k) => tx('readonly', (s) => s.get(k));
export const dbSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const dbDel = (k) => tx('readwrite', (s) => s.delete(k));

/** Write several keys atomically (used so header + data can never get out of sync). */
export async function dbSetMany(obj) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    for (const [k, v] of Object.entries(obj)) s.put(v, k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function dbClearAll() {
  return tx('readwrite', (s) => s.clear());
}

/** Test helper: drop the cached connection. */
export function _resetDb() {
  dbp = undefined;
}
