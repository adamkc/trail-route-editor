/**
 * session-store.js — Persist the working session (trails, waypoints, frozen
 * vertices, DEM reference, view) in the browser so a reload or closed tab
 * does not lose work. IndexedDB, falling back to localStorage.
 */
const SessionStore = (() => {
  const DB_NAME = 'trail-editor-session';
  const STORE = 'kv';
  const KEY = 'autosave';
  const LS_KEY = 'trail-editor-autosave';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked')); };
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    }));
  }

  async function save(state) {
    try {
      await tx('readwrite', s => s.put(state, KEY));
    } catch (e) {
      localStorage.setItem(LS_KEY, JSON.stringify(state));  // throws if that fails too
    }
  }

  async function load() {
    try {
      const v = await tx('readonly', s => s.get(KEY));
      if (v) return v;
    } catch (e) {}
    try {
      const s = localStorage.getItem(LS_KEY);
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  }

  async function clear() {
    try { await tx('readwrite', s => s.delete(KEY)); } catch (e) {}
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  return { save, load, clear };
})();
