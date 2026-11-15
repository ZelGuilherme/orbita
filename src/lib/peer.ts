import Peer, { type PeerError, type PeerOptions } from 'peerjs';
import { loadSettings } from './storage';

export class PeerOpenError extends Error {
  constructor(
    readonly type: string,
    message?: string,
  ) {
    super(message ?? type);
  }
}

export function parseIceServers(json: string): RTCIceServer[] | null {
  if (!json.trim()) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (
      Array.isArray(value) &&
      value.every((s) => s && typeof s === 'object' && (typeof s.urls === 'string' || Array.isArray(s.urls)))
    ) {
      return value as RTCIceServer[];
    }
  } catch {
    /* JSON inválido: usa o padrão */
  }
  return null;
}

/**
 * Log do PeerJS sem o ruído esperado: durante uma troca de host todo mundo tenta
 * achar o hub novo e o servidor responde "peer não existe" algumas vezes.
 */
function peerLog(level: number, ...rest: unknown[]) {
  const text = rest.map((r) => (r instanceof Error ? r.message : String(r))).join(' ');
  if (/Could not connect to peer/.test(text)) return;
  if (level <= 1) console.error('PeerJS:', ...rest);
  else console.warn('PeerJS:', ...rest);
}

/** Opções do PeerJS a partir das configurações de rede salvas. */
export function peerOptions(): PeerOptions {
  const net = loadSettings().network;
  const options: PeerOptions = { debug: 1, logFunction: peerLog };
  if (net.host.trim()) {
    options.host = net.host.trim();
    options.port = net.port || (net.secure ? 443 : 80);
    options.path = net.path || '/';
    options.secure = net.secure;
    if (net.key.trim()) options.key = net.key.trim();
  }
  const iceServers = parseIceServers(net.iceServersJson);
  if (iceServers) options.config = { iceServers };
  return options;
}

/** Abre um peer no servidor de sinalização (com ID fixo, se informado). */
export function openPeer(id?: string, timeoutMs = 15_000): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const options = peerOptions();
    const peer = id ? new Peer(id, options) : new Peer(options);
    let done = false;
    const finish = (err?: PeerOpenError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onError);
      if (err) {
        peer.destroy();
        reject(err);
      } else {
        resolve(peer);
      }
    };
    const onOpen = () => finish();
    const onError = (err: PeerError<string>) => finish(new PeerOpenError(err.type, err.message));
    const timer = window.setTimeout(() => finish(new PeerOpenError('timeout')), timeoutMs);
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

/**
 * Se a conexão com o servidor de sinalização cair, tenta voltar com o mesmo ID.
 * (As conexões WebRTC já abertas continuam funcionando sem o servidor.)
 */
export function keepSignaling(peer: Peer, active: () => boolean) {
  let timer = 0;
  const retry = () => {
    timer = 0;
    if (!active() || peer.destroyed || !peer.disconnected) return;
    try {
      peer.reconnect();
    } catch {
      /* tenta de novo */
    }
    timer = window.setTimeout(retry, 5_000);
  };
  peer.on('disconnected', () => {
    if (!timer) timer = window.setTimeout(retry, 1_000);
  });
}
