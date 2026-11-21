/**
 * Chave de identidade de cada perfil (ECDSA P-256, WebCrypto).
 *
 * Os IDs de quem está na sala são públicos, então só o ID não prova quem é quem. Cada perfil
 * tem um par de chaves: a pública vai para a sala, a privada nunca sai do navegador (nem dá para
 * exportar). Para voltar com um ID que já está na sala, ou receber a coroa de quem criou uma
 * órbita fixa, é preciso assinar a entrada com a chave certa.
 *
 * A assinatura cobre a sala, o ID, o peer da conexão (que o servidor de sinalização garante) e a
 * hora: ninguém reaproveita a entrada de outra pessoa.
 */

const DB = 'orbita-keys';
const STORE = 'keys';
const ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
/** Diferença de relógio aceita entre quem entra e o host. */
export const HELLO_WINDOW_MS = 10 * 60_000;

export interface ProfileKey {
  privateKey: CryptoKey;
  /** Chave pública (formato "raw", base64url). */
  pub: string;
}

const canCrypto = () => typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Formato de uma chave pública (P-256 "raw" = 65 bytes = 87 caracteres). */
export const KEY_FORMAT = /^[A-Za-z0-9_-]{87}$/;
const SIG_FORMAT = /^[A-Za-z0-9_-]{60,120}$/;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const cache = new Map<string, Promise<ProfileKey | null>>();

async function loadOrCreate(profileId: string): Promise<ProfileKey | null> {
  if (!canCrypto()) return null;
  const db = await openDb();
  const name = `profile:${profileId}`;
  let pair = db ? await idb<CryptoKeyPair>(db, 'readonly', (s) => s.get(name)) : undefined;
  if (!pair?.privateKey || !pair.publicKey) {
    pair = await crypto.subtle.generateKey(ALGO, false, ['sign', 'verify']);
    if (db) await idb(db, 'readwrite', (s) => s.put(pair, name));
  }
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, pub: b64url(raw) };
}

/** A chave do perfil (criada na primeira vez). Sem WebCrypto, null: entra sem prova, como antes. */
export function profileKey(profileId: string): Promise<ProfileKey | null> {
  let p = cache.get(profileId);
  if (!p) {
    p = loadOrCreate(profileId).catch((err) => {
      console.warn('[chave] sem chave de identidade', err);
      return null;
    });
    cache.set(profileId, p);
  }
  return p;
}

/** O que é assinado ao entrar numa sala. */
export const helloPayload = (code: string, memberId: string, wirePeer: string, ts: number) => `orbita-hello|1|${code}|${memberId}|${wirePeer}|${ts}`;

export async function signHello(key: ProfileKey, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN, key.privateKey, new TextEncoder().encode(payload));
  return b64url(sig);
}

const imported = new Map<string, Promise<CryptoKey | null>>();

/** Confere a assinatura de uma entrada. */
export async function verifyHello(pub: string, payload: string, sig: string): Promise<boolean> {
  if (!canCrypto() || !KEY_FORMAT.test(pub) || !SIG_FORMAT.test(sig)) return false;
  let key = imported.get(pub);
  if (!key) {
    const raw = fromB64url(pub);
    key = raw ? crypto.subtle.importKey('raw', raw, ALGO, false, ['verify']).catch(() => null) : Promise.resolve(null);
    if (imported.size > 500) imported.clear();
    imported.set(pub, key);
  }
  const k = await key;
  const bytes = fromB64url(sig);
  if (!k || !bytes) return false;
  try {
    return await crypto.subtle.verify(SIGN, k, bytes, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}
