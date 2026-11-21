import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { hubPeerId } from './hub';

/**
 * Tem alguém numa órbita fixa? Uma "espiada" rápida no hub da sala: ele responde quantas
 * pessoas estão lá e fecha a conexão (sem entrar, sem aparecer para ninguém).
 *  - { open: false }: ninguém (o hub não existe);
 *  - { open: true, members }: aberta (members null = hub de versão antiga, que não conta).
 */
export type RoomPeek = { open: false } | { open: true; members: number | null };

/** null = não deu para saber (sinalização fora do ar etc.). */
export function peekRoom(peer: Peer, code: string, timeoutMs = 6_000): Promise<RoomPeek | null> {
  const hubId = hubPeerId(code);
  return new Promise((resolve) => {
    let opened = false;
    let done = false;
    let conn: DataConnection | undefined;
    const finish = (value: RoomPeek | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.off('error', onError);
      try {
        conn?.close();
      } catch {
        /* já fechada */
      }
      resolve(value);
    };
    const onError = (err: { type: string; message: string }) => {
      if (err.type === 'peer-unavailable' && err.message.includes(hubId)) finish({ open: false });
    };
    const timer = window.setTimeout(() => finish(opened ? { open: true, members: null } : null), timeoutMs);
    peer.on('error', onError);
    conn = peer.connect(hubId, { reliable: true, serialization: 'raw', metadata: { kind: 'peek' } }) as DataConnection | undefined;
    if (!conn) {
      finish(null);
      return;
    }
    conn.on('open', () => {
      opened = true;
    });
    conn.on('data', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { t?: unknown; members?: unknown };
        if (msg?.t !== 'peek') return;
        const n = Math.floor(Number(msg.members));
        finish({ open: true, members: Number.isFinite(n) ? Math.max(0, Math.min(999, n)) : null });
      } catch {
        /* ignora */
      }
    });
    conn.on('close', () => {
      if (opened) finish({ open: true, members: null });
    });
  });
}
