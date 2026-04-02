/**
 * cache-store.js — IndexedDB abstraction for cached DEM-derived data.
 *
 * Stores:
 *   metadata       — DEM info + ROI bounds (keyed by demId)
 *   roi-raster     — Clipped Float32Array raster (keyed by demId)
 *   aspect-grid    — Pre-built aspect Float32Array (keyed by demId)
 *   raster-tiles   — Contour PNG tiles zoom 8-13 (keyed by 'demId/z/x/y')
 *   vector-tiles   — Contour GeoJSON tiles zoom 14+ (keyed by 'demId/z/x/y')
 *   terrain-tiles  — Terrarium-encoded PNG tiles (keyed by 'demId/z/x/y')
 *   contours       — Legacy full-raster contour cache (backward compat)
 *
 * All operations are fail-safe: if IndexedDB is unavailable or blocked,
 * reads return null and writes are silently skipped. The app continues
 * without caching (data is regenerated each session).
 */
const CacheStore = (() => {
  const DB_NAME = 'trail-editor-v2';
  const DB_VERSION = 1;
  const STORES = [
    'metadata', 'roi-raster', 'aspect-grid',
    'raster-tiles', 'vector-tiles', 'terrain-tiles',
    'contours'
  ];

  const OPEN_TIMEOUT_MS = 4000;
  const MAX_OPEN_RETRIES = 2;

  let dbPromise = null;
  let dbUnavailable = false;
  let openAttempts = 0;

  function open() {
    if (dbUnavailable) return Promise.reject(new Error('IndexedDB unavailable'));
    if (dbPromise) return dbPromise;

    openAttempts++;
    if (openAttempts > MAX_OPEN_RETRIES) {
      dbUnavailable = true;
      console.warn('[CacheStore] IndexedDB failed after', MAX_OPEN_RETRIES, 'attempts — disabling cache for this session');
      return Promise.reject(new Error('IndexedDB unavailable'));
    }

    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn('[CacheStore] IndexedDB open timed out (' + openAttempts + '/' + MAX_OPEN_RETRIES + ')');
          dbPromise = null; // allow retry (up to MAX_OPEN_RETRIES)
          reject(new Error('IndexedDB open timeout'));
        }
      }, OPEN_TIMEOUT_MS);

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          for (const name of STORES) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name);
            }
          }
        };
        req.onsuccess = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            console.log('[CacheStore] IndexedDB opened');
            resolve(req.result);
          }
        };
        req.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            console.warn('[CacheStore] IndexedDB open error:', req.error);
            dbPromise = null;
            reject(req.error);
          }
        };
        req.onblocked = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            console.warn('[CacheStore] IndexedDB open blocked');
            dbPromise = null;
            reject(new Error('IndexedDB blocked'));
          }
        };
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          dbPromise = null;
          reject(e);
        }
      }
    });
    return dbPromise;
  }

  // ── Internal helpers (all fail-safe) ──

  async function _get(storeName, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function _put(storeName, key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function _delete(storeName, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── Public API ──

  async function getMetadata(demId) {
    try { return await _get('metadata', demId); }
    catch (e) { return null; }
  }

  async function putMetadata(demId, meta) {
    try { return await _put('metadata', demId, { ...meta, demId, timestamp: Date.now() }); }
    catch (e) { console.warn('[CacheStore] putMetadata failed:', e.message); }
  }

  /**
   * Store a raster grid object. Converts Float32Array to ArrayBuffer for IDB storage.
   */
  async function putGrid(storeName, demId, gridObj) {
    try {
      const stored = {
        width: gridObj.width,
        height: gridObj.height,
        originX: gridObj.originX,
        originY: gridObj.originY,
        pixelSizeX: gridObj.pixelSizeX || gridObj.pxX,
        pixelSizeY: gridObj.pixelSizeY || gridObj.pxY,
        buffer: gridObj.data.buffer.slice(0) // clone the ArrayBuffer
      };
      return await _put(storeName, demId, stored);
    } catch (e) {
      console.warn('[CacheStore] putGrid failed:', e.message);
    }
  }

  /**
   * Retrieve a raster grid object. Reconstructs Float32Array from stored ArrayBuffer.
   */
  async function getGrid(storeName, demId) {
    try {
      const stored = await _get(storeName, demId);
      if (!stored) return null;
      return {
        data: new Float32Array(stored.buffer),
        width: stored.width,
        height: stored.height,
        originX: stored.originX,
        originY: stored.originY,
        pixelSizeX: stored.pixelSizeX,
        pixelSizeY: stored.pixelSizeY,
        pxX: stored.pixelSizeX,
        pxY: stored.pixelSizeY
      };
    } catch (e) {
      return null;
    }
  }

  async function putTile(storeName, key, data) {
    try { return await _put(storeName, key, data); }
    catch (e) { /* skip silently */ }
  }

  async function getTile(storeName, key) {
    try { return await _get(storeName, key); }
    catch (e) { return null; }
  }

  /**
   * Check if a preprocessed DEM exists in cache.
   */
  async function hasCachedDem(demId) {
    try {
      const meta = await getMetadata(demId);
      if (!meta) return false;
      // Also verify the ROI raster exists (metadata alone is not sufficient)
      const roi = await _get('roi-raster', demId);
      return roi !== null;
    } catch (e) {
      return false;
    }
  }

  /**
   * Remove all cached data for a specific DEM.
   */
  async function clearDem(demId) {
    try {
      const db = await open();
      // Clear metadata + grids (direct key deletes)
      for (const storeName of ['metadata', 'roi-raster', 'aspect-grid']) {
        try { await _delete(storeName, demId); } catch (e) {}
      }
      // Clear tiles — getAllKeys then batch delete matching prefix
      const prefix = demId + '/';
      for (const storeName of ['raster-tiles', 'vector-tiles', 'terrain-tiles']) {
        try {
          const keys = await new Promise((resolve) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
          });
          const matching = keys.filter(k => typeof k === 'string' && k.startsWith(prefix));
          if (matching.length > 0) {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            for (const key of matching) store.delete(key);
            await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
          }
        } catch (e) {}
      }
      console.log('[CacheStore] Cleared cache for DEM:', demId);
    } catch (e) {
      console.warn('[CacheStore] clearDem failed:', e.message);
    }
  }

  function makeDemId(fileName, fileSize) {
    return (fileName || 'dem').replace(/[^a-zA-Z0-9._-]/g, '_') + '_' + fileSize;
  }

  /**
   * Close the DB connection and reset. Call before deleteDatabase.
   */
  function reset() {
    if (dbPromise) {
      dbPromise.then(db => { try { db.close(); } catch (e) {} }).catch(() => {});
      dbPromise = null;
    }
    dbUnavailable = false;
    openAttempts = 0;
  }

  /**
   * Mark IndexedDB as unavailable (skip all future operations).
   */
  function disable() {
    dbUnavailable = true;
    dbPromise = null;
  }

  return {
    open, getMetadata, putMetadata,
    putGrid, getGrid,
    putTile, getTile,
    hasCachedDem, clearDem,
    makeDemId, reset, disable
  };
})();
