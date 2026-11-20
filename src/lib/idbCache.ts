/**
 * Cache no navegador (IndexedDB) para coisas caras de refazer: texturas dos planetas, o céu e
 * as imagens dos planetas. Some se o navegador limpar os dados; tudo funciona sem ele.
 */

const DB = 'orbita-cache';
const VERSION = 1;
export type CacheStore = 'maps' | 'thumbs';
const LIMITS: Record<CacheStore, number> = { maps: 60, thumbs: 240 };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = () => {
          for (const store of Object.keys(LIMITS)) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

interface Entry<T> {
  at: number;
  value: T;
}

export async function cacheGet<T>(store: CacheStore, key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as Entry<T> | undefined)?.value);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

let writes = 0;

export async function cacheSet<T>(store: CacheStore, key: string, value: T): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put({ at: Date.now(), value } satisfies Entry<T>, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  // de vez em quando, joga fora as mais antigas
  if (++writes % 10 === 0) void prune(store);
}

async function prune(store: CacheStore) {
  const db = await open();
  if (!db) return;
  try {
    const os = db.transaction(store, 'readwrite').objectStore(store);
    const all: Array<{ key: IDBValidKey; at: number }> = [];
    const req = os.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        all.push({ key: cursor.key, at: (cursor.value as Entry<unknown>).at ?? 0 });
        cursor.continue();
        return;
      }
      if (all.length <= LIMITS[store]) return;
      all.sort((a, b) => a.at - b.at);
      for (const old of all.slice(0, all.length - LIMITS[store])) os.delete(old.key);
    };
  } catch {
    /* sem espaço ou sem permissão: tudo bem */
  }
}
