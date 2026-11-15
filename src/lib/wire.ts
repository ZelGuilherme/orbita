import type { DataConnection } from 'peerjs';

/**
 * Canal de mensagens JSON entre um participante e o hub.
 * - PeerWire: por cima de um DataChannel WebRTC (PeerJS, serialização "raw").
 * - LocalWire: o próprio host conversando com o hub que roda na mesma aba.
 */
export interface Wire {
  readonly kind: 'local' | 'peer';
  readonly isOpen: boolean;
  send(msg: unknown): void;
  /** Fecha por iniciativa local (não dispara onClose). */
  close(): void;
  // `any` de propósito: cada lado tipa a mensagem que espera (ClientMsg / HubMsg)
  onMessage: (msg: any) => void;
  /** Disparado quando o outro lado fecha ou a conexão cai. */
  onClose: () => void;
}

const noop = () => {};
/** Pedaços de até 4800 caracteres: ≤ 14,4 KB em UTF-8, abaixo do limite seguro de 16 KB. */
const CHUNK = 4800;
const MAX_CHUNKS = 4000;

export class PeerWire implements Wire {
  readonly kind = 'peer';
  onMessage: (msg: unknown) => void = noop;
  onClose: () => void = noop;
  private closed = false;
  private partial = new Map<string, { parts: string[]; got: number }>();

  constructor(readonly conn: DataConnection) {
    conn.on('data', (data) => this.receive(data));
    conn.on('close', () => this.lost());
    conn.on('error', (err) => console.warn('[wire]', err.type, err.message));
  }

  get isOpen() {
    return !this.closed && this.conn.open;
  }

  send(msg: unknown) {
    if (this.closed) return;
    const json = JSON.stringify(msg);
    try {
      if (json.length <= CHUNK) {
        void this.conn.send(json);
        return;
      }
      const id = Math.random().toString(36).slice(2, 10);
      const parts: string[] = [];
      let i = 0;
      while (i < json.length) {
        let end = Math.min(i + CHUNK, json.length);
        const code = json.charCodeAt(end - 1);
        // não corta um par substituto (emoji) ao meio
        if (end < json.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
        parts.push(json.slice(i, end));
        i = end;
      }
      parts.forEach((part, index) => void this.conn.send(`~${id}|${index}|${parts.length}|${part}`));
    } catch (err) {
      console.warn('[wire] falha ao enviar', err);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.partial.clear();
    try {
      this.conn.close();
    } catch {
      /* já fechada */
    }
  }

  private lost() {
    if (this.closed) return;
    this.closed = true;
    this.partial.clear();
    this.onClose();
  }

  private receive(data: unknown) {
    if (typeof data !== 'string' || this.closed) return;
    if (data.charCodeAt(0) !== 126 /* ~ */) {
      this.deliver(data);
      return;
    }
    const a = data.indexOf('|');
    const b = data.indexOf('|', a + 1);
    const c = data.indexOf('|', b + 1);
    if (a < 0 || b < 0 || c < 0) return;
    const id = data.slice(1, a);
    const index = Number(data.slice(a + 1, b));
    const total = Number(data.slice(b + 1, c));
    if (!Number.isInteger(index) || !Number.isInteger(total) || total > MAX_CHUNKS || index < 0 || index >= total) return;
    let entry = this.partial.get(id);
    if (!entry) {
      if (this.partial.size > 16) this.partial.clear();
      entry = { parts: new Array<string>(total), got: 0 };
      this.partial.set(id, entry);
    }
    if (entry.parts[index] === undefined) {
      entry.parts[index] = data.slice(c + 1);
      entry.got += 1;
    }
    if (entry.got === total) {
      this.partial.delete(id);
      this.deliver(entry.parts.join(''));
    }
  }

  private deliver(json: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      this.onMessage(msg);
    } catch (err) {
      console.error('[wire] erro ao tratar mensagem', err);
    }
  }
}

class LocalWire implements Wire {
  readonly kind = 'local';
  onMessage: (msg: unknown) => void = noop;
  onClose: () => void = noop;
  other: LocalWire | null = null;
  private closed = false;

  get isOpen() {
    return !this.closed;
  }

  send(msg: unknown) {
    const target = this.other;
    if (this.closed || !target) return;
    // serializa como na rede: ninguém compartilha objetos mutáveis com o hub
    const json = JSON.stringify(msg);
    queueMicrotask(() => {
      if (target.closed) return;
      try {
        target.onMessage(JSON.parse(json));
      } catch (err) {
        console.error('[wire] erro ao tratar mensagem local', err);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const other = this.other;
    this.other = null;
    if (other) queueMicrotask(() => other.lost());
  }

  private lost() {
    if (this.closed) return;
    this.closed = true;
    this.other = null;
    this.onClose();
  }
}

export function createLocalPair(): [Wire, Wire] {
  const a = new LocalWire();
  const b = new LocalWire();
  a.other = b;
  b.other = a;
  return [a, b];
}
