import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { MAX_FILE_BYTES } from './config';
import type { FileAttachment } from './protocol';
import { randomId } from './util';

/**
 * Arquivos do chat: ficam no computador de quem mandou. Quem clica em "Baixar" abre uma
 * conexão de dados direto com essa pessoa (o host não carrega nada) e recebe o arquivo em
 * pedaços, com controle de fluxo para não estourar a memória do navegador.
 *
 * Mensagens da conexão (texto JSON + pedaços binários):
 *   dono → quem baixa: {head:{name,size,mime}} · pedaços · {end:true}   ou   {error:'gone'}
 */

const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const IDLE_MS = 20_000;

export interface TransferEvents {
  progress(fileId: string, received: number, size: number): void;
  done(fileId: string): void;
  failed(fileId: string, reason: 'gone' | 'lost'): void;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} MB`;
}

/** Entrega um arquivo para o navegador salvar. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export class FileShare {
  private files = new Map<string, File>();
  private serving = new Set<DataConnection>();
  private downloads = new Map<string, DataConnection>();
  private stopped = false;

  constructor(
    private peer: Peer,
    /** O peer pertence a alguém da sala? (só quem está na sala pode baixar) */
    private isMember: (peerId: string) => boolean,
    private ev: TransferEvents,
  ) {
    peer.on('connection', (conn) => {
      const meta = conn.metadata as { kind?: string; fileId?: unknown } | undefined;
      if (meta?.kind === 'file') this.serve(conn, typeof meta.fileId === 'string' ? meta.fileId : '');
    });
  }

  /** Guarda o arquivo para quem quiser baixar e devolve o anexo da mensagem. */
  share(file: File, ownerId: string): FileAttachment {
    if (file.size <= 0) throw new Error('O arquivo está vazio.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Arquivo grande demais (máx. 100 MB).');
    const fileId = randomId(16);
    this.files.set(fileId, file);
    return { kind: 'file', name: file.name || 'arquivo', size: file.size, mime: file.type || 'application/octet-stream', fileId, ownerId };
  }

  /** O próprio arquivo (quem mandou salva direto da memória). */
  local(fileId: string): File | undefined {
    return this.files.get(fileId);
  }

  isDownloading(fileId: string) {
    return this.downloads.has(fileId);
  }

  download(attachment: FileAttachment, ownerPeerId: string) {
    if (this.stopped || this.downloads.has(attachment.fileId)) return;
    const conn = this.peer.connect(ownerPeerId, { reliable: true, serialization: 'raw', metadata: { kind: 'file', fileId: attachment.fileId } }) as
      | DataConnection
      | undefined;
    if (!conn) {
      this.ev.failed(attachment.fileId, 'lost');
      return;
    }
    const fileId = attachment.fileId;
    this.downloads.set(fileId, conn);
    const parts: ArrayBuffer[] = [];
    let size = -1;
    const mime = attachment.mime;
    let received = 0;
    let lastReport = 0;
    let finished = false;
    let idle = 0;
    const finish = (error?: 'gone' | 'lost') => {
      if (finished) return;
      finished = true;
      clearTimeout(idle);
      // cancelado por quem baixava: some sem aviso
      const active = this.downloads.get(fileId) === conn;
      if (active) this.downloads.delete(fileId);
      try {
        conn.close();
      } catch {
        /* já fechada */
      }
      if (!active) return;
      if (error) {
        this.ev.failed(fileId, error);
        return;
      }
      saveBlob(new Blob(parts, { type: mime }), attachment.name);
      this.ev.done(fileId);
    };
    const touch = () => {
      clearTimeout(idle);
      idle = window.setTimeout(() => finish('lost'), IDLE_MS);
    };
    touch();
    conn.on('data', (data) => {
      if (finished) return;
      touch();
      if (typeof data === 'string') {
        let msg: { head?: { size?: number }; end?: boolean; error?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.error) finish('gone');
        else if (msg.head) {
          size = Math.floor(Number(msg.head.size));
          if (size !== attachment.size) finish('lost');
        } else if (msg.end) {
          finish(received === size ? undefined : 'lost');
        }
        return;
      }
      if (!(data instanceof ArrayBuffer) || size < 0) return;
      parts.push(data);
      received += data.byteLength;
      if (received > size) {
        finish('lost');
        return;
      }
      const now = performance.now();
      if (now - lastReport > 150) {
        lastReport = now;
        this.ev.progress(fileId, received, size);
      }
    });
    conn.on('close', () => finish('lost'));
    conn.on('error', () => finish('lost'));
  }

  cancel(fileId: string) {
    const conn = this.downloads.get(fileId);
    if (!conn) return;
    this.downloads.delete(fileId);
    try {
      conn.close();
    } catch {
      /* já fechada */
    }
  }

  stop() {
    this.stopped = true;
    for (const conn of [...this.serving, ...this.downloads.values()]) {
      try {
        conn.close();
      } catch {
        /* já fechada */
      }
    }
    this.serving.clear();
    this.downloads.clear();
    this.files.clear();
  }

  private serve(conn: DataConnection, fileId: string) {
    if (this.stopped || this.serving.size >= 8) {
      conn.close();
      return;
    }
    this.serving.add(conn);
    let closed = false;
    const done = () => {
      closed = true;
      this.serving.delete(conn);
    };
    conn.on('close', done);
    conn.on('error', done);
    conn.on('open', () => {
      const file = this.files.get(fileId);
      if (!file || !this.isMember(conn.peer)) {
        conn.send(JSON.stringify({ error: 'gone' }));
        window.setTimeout(() => conn.close(), 1_000);
        return;
      }
      void this.pump(conn, file, () => closed || this.stopped);
    });
  }

  private async pump(conn: DataConnection, file: File, cancelled: () => boolean) {
    conn.send(JSON.stringify({ head: { size: file.size, mime: file.type } }));
    const channel = conn.dataChannel;
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      if (cancelled()) return;
      if (channel.bufferedAmount > HIGH_WATER) {
        channel.bufferedAmountLowThreshold = LOW_WATER;
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 5_000);
          channel.addEventListener(
            'bufferedamountlow',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (cancelled()) return;
      }
      let chunk: ArrayBuffer;
      try {
        chunk = await file.slice(offset, offset + CHUNK).arrayBuffer();
      } catch {
        conn.close();
        return;
      }
      conn.send(chunk);
    }
    conn.send(JSON.stringify({ end: true }));
  }
}
