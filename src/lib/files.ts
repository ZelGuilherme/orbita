import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { MAX_FILE_BYTES } from './config';
import type { FileAttachment } from './protocol';
import { randomId } from './util';

/**
 * Arquivos do chat (até 1 GB): ficam no computador de quem mandou. Quem clica em "Baixar" abre
 * uma conexão de dados direto com essa pessoa (o host não carrega nada) e recebe o arquivo em
 * pedaços, com controle de fluxo. Arquivos grandes vão direto para o disco (Chrome/Edge/Brave),
 * e se a conexão cair o download continua de onde parou.
 *
 * Mensagens da conexão (texto JSON + pedaços binários):
 *   quem baixa → dono: metadata {kind:'file', fileId, offset}
 *   dono → quem baixa: {head:{size, offset}} · pedaços · {end:true}   ou   {error:'gone'}
 */

const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const IDLE_MS = 20_000;
/** Sem gravar no disco, o arquivo fica inteiro na memória até terminar: acima disto, não. */
export const MEMORY_LIMIT = 200 * 1024 * 1024;
/** A partir daqui, pergunta onde salvar e grava direto no disco (onde o navegador deixa). */
function diskFrom(): number {
  // nos testes dá para baixar o limite e exercitar a gravação em disco com arquivos menores
  if (import.meta.env.DEV) {
    try {
      const v = Number(localStorage.getItem('orbita.diskFrom'));
      if (v > 0) return v;
    } catch {
      /* sem armazenamento */
    }
  }
  return 100 * 1024 * 1024;
}
const MAX_RETRIES = 8;

export interface TransferEvents {
  progress(fileId: string, received: number, size: number, speed: number): void;
  retrying(fileId: string): void;
  done(fileId: string): void;
  failed(fileId: string, reason: 'gone' | 'lost' | 'disk'): void;
}

/** Arquivos que rodam programas ao abrir: o chat avisa antes de baixar. */
export const isRisky = (name: string) => /\.(exe|msi|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar|apk|lnk|reg|cpl|dll|sh|appimage|dmg|pkg)$/i.test(name.trim());

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} GB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${String(Math.round(seconds % 60)).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
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

type SavePicker = (opts: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;

/** O navegador grava direto no disco enquanto baixa (Chrome, Edge, Brave)? */
export const canSaveToDisk = () => typeof (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker === 'function';

/** Este navegador consegue baixar um arquivo deste tamanho? */
export const canDownloadSize = (size: number) => size <= MEMORY_LIMIT || canSaveToDisk();

/** Para onde vão os pedaços: memória (e no fim "salvar") ou direto num arquivo do disco. */
interface Sink {
  write(chunk: ArrayBuffer): void;
  /** Termina de gravar (e entrega o arquivo, no caso da memória). */
  close(): Promise<void>;
  abort(): void;
}

function memorySink(name: string): Sink {
  let parts: ArrayBuffer[] = [];
  return {
    write: (chunk) => void parts.push(chunk),
    close: async () => {
      // tipo genérico: o navegador só baixa, nunca abre o arquivo dentro do site
      saveBlob(new Blob(parts, { type: 'application/octet-stream' }), name);
      parts = [];
    },
    abort: () => {
      parts = [];
    },
  };
}

function diskSink(writable: FileSystemWritableFileStream, onError: () => void): Sink {
  // junta pedaços pequenos em blocos de ~1 MB (menos idas ao disco)
  let batch: ArrayBuffer[] = [];
  let batchSize = 0;
  let chain: Promise<void> = Promise.resolve();
  let failed = false;
  const flush = () => {
    if (!batchSize) return;
    const blob = new Blob(batch);
    batch = [];
    batchSize = 0;
    chain = chain.then(() => writable.write(blob)).catch(() => {
      if (!failed) {
        failed = true;
        onError();
      }
    });
  };
  return {
    write: (chunk) => {
      batch.push(chunk);
      batchSize += chunk.byteLength;
      if (batchSize >= 1024 * 1024) flush();
    },
    close: async () => {
      flush();
      await chain;
      if (!failed) await writable.close();
    },
    abort: () => {
      batch = [];
      void chain.then(() => writable.abort()).catch(() => {});
    },
  };
}

interface Download {
  attachment: FileAttachment;
  sink: Sink;
  received: number;
  conn: DataConnection | null;
  attempts: number;
  retryTimer: number;
  idle: number;
  /** Velocidade (média móvel), bytes por segundo. */
  speed: number;
  windowStart: number;
  windowBytes: number;
  lastReport: number;
  done: boolean;
}

export class FileShare {
  private files = new Map<string, File>();
  private serving = new Set<DataConnection>();
  private downloads = new Map<string, Download>();
  private stopped = false;

  constructor(
    private peer: Peer,
    /** O peer pertence a alguém da sala? (só quem está na sala pode baixar) */
    private isMember: (peerId: string) => boolean,
    /** Peer atual de quem tem o arquivo (null = saiu da sala). */
    private ownerPeer: (ownerId: string) => string | null,
    private ev: TransferEvents,
  ) {
    peer.on('connection', (conn) => {
      const meta = conn.metadata as { kind?: string; fileId?: unknown; offset?: unknown } | undefined;
      if (meta?.kind === 'file') this.serve(conn, typeof meta.fileId === 'string' ? meta.fileId : '', Math.max(0, Math.floor(Number(meta.offset) || 0)));
      // ninguém mais abre conexões de dados com este peer: o resto é fechado
      else conn.close();
    });
  }

  /** Guarda o arquivo para quem quiser baixar e devolve o anexo da mensagem. */
  share(file: File, ownerId: string): FileAttachment {
    if (file.size <= 0) throw new Error('O arquivo está vazio.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Arquivo grande demais (máx. 1 GB).');
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

  /**
   * Começa a baixar. Arquivos grandes pedem onde salvar (precisa ser chamado num clique).
   * Devolve false se a pessoa cancelou a janela de salvar ou o navegador não dá conta.
   */
  async download(attachment: FileAttachment): Promise<boolean> {
    if (this.stopped || this.downloads.has(attachment.fileId)) return false;
    let sink: Sink;
    const big = attachment.size > diskFrom();
    if (big && canSaveToDisk()) {
      try {
        const handle = await (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker({ suggestedName: attachment.name });
        const writable = await handle.createWritable();
        sink = diskSink(writable, () => this.fail(attachment.fileId, 'disk'));
      } catch {
        return false;
      }
    } else if (attachment.size <= MEMORY_LIMIT) {
      sink = memorySink(attachment.name);
    } else {
      return false;
    }
    const d: Download = {
      attachment,
      sink,
      received: 0,
      conn: null,
      attempts: 0,
      retryTimer: 0,
      idle: 0,
      speed: 0,
      windowStart: performance.now(),
      windowBytes: 0,
      lastReport: 0,
      done: false,
    };
    this.downloads.set(attachment.fileId, d);
    this.connect(d);
    return true;
  }

  /** (Re)conecta com quem tem o arquivo, pedindo a partir do que já chegou. */
  private connect(d: Download) {
    const fileId = d.attachment.fileId;
    if (this.downloads.get(fileId) !== d || this.stopped) return;
    const owner = this.ownerPeer(d.attachment.ownerId);
    if (!owner) {
      this.fail(fileId, 'gone');
      return;
    }
    const conn = this.peer.connect(owner, { reliable: true, serialization: 'raw', metadata: { kind: 'file', fileId, offset: d.received } }) as DataConnection | undefined;
    if (!conn) {
      this.retry(d);
      return;
    }
    d.conn = conn;
    let started = false;
    const touch = () => {
      clearTimeout(d.idle);
      d.idle = window.setTimeout(() => lost(), IDLE_MS);
    };
    const lost = () => {
      if (d.conn !== conn) return;
      d.conn = null;
      clearTimeout(d.idle);
      try {
        conn.close();
      } catch {
        /* já fechada */
      }
      if (!d.done && this.downloads.get(fileId) === d) this.retry(d);
    };
    touch();
    conn.on('data', (data) => {
      if (d.conn !== conn || d.done) return;
      touch();
      if (typeof data === 'string') {
        let msg: { head?: { size?: number; offset?: number }; end?: boolean; error?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.error) this.fail(fileId, 'gone');
        else if (msg.head) {
          // o arquivo e o ponto de partida têm que bater com o que já temos
          if (Math.floor(Number(msg.head.size)) !== d.attachment.size || Math.floor(Number(msg.head.offset)) !== d.received) this.fail(fileId, 'lost');
          else {
            started = true;
            d.attempts = 0;
          }
        } else if (msg.end) {
          if (d.received === d.attachment.size) void this.finish(d);
          else lost();
        }
        return;
      }
      if (!started || !(data instanceof ArrayBuffer)) return;
      if (d.received + data.byteLength > d.attachment.size) {
        this.fail(fileId, 'lost');
        return;
      }
      d.sink.write(data);
      d.received += data.byteLength;
      d.windowBytes += data.byteLength;
      const now = performance.now();
      if (now - d.windowStart >= 1000) {
        const rate = (d.windowBytes * 1000) / (now - d.windowStart);
        d.speed = d.speed ? d.speed * 0.6 + rate * 0.4 : rate;
        d.windowStart = now;
        d.windowBytes = 0;
      }
      if (now - d.lastReport > 200) {
        d.lastReport = now;
        this.ev.progress(fileId, d.received, d.attachment.size, d.speed);
      }
    });
    conn.on('close', lost);
    conn.on('error', lost);
  }

  /** A conexão caiu: tenta de novo (com espera crescente), continuando de onde parou. */
  private retry(d: Download) {
    const fileId = d.attachment.fileId;
    if (this.downloads.get(fileId) !== d) return;
    d.attempts++;
    if (d.attempts > MAX_RETRIES) {
      this.fail(fileId, 'lost');
      return;
    }
    this.ev.retrying(fileId);
    clearTimeout(d.retryTimer);
    d.retryTimer = window.setTimeout(() => this.connect(d), Math.min(15_000, 1_000 * 2 ** (d.attempts - 1)));
  }

  private async finish(d: Download) {
    if (d.done) return;
    d.done = true;
    clearTimeout(d.idle);
    clearTimeout(d.retryTimer);
    try {
      d.conn?.close();
    } catch {
      /* já fechada */
    }
    this.downloads.delete(d.attachment.fileId);
    try {
      await d.sink.close();
      this.ev.done(d.attachment.fileId);
    } catch {
      this.ev.failed(d.attachment.fileId, 'disk');
    }
  }

  private fail(fileId: string, reason: 'gone' | 'lost' | 'disk') {
    const d = this.downloads.get(fileId);
    if (!d) return;
    this.drop(d);
    this.ev.failed(fileId, reason);
  }

  private drop(d: Download) {
    d.done = true;
    clearTimeout(d.idle);
    clearTimeout(d.retryTimer);
    this.downloads.delete(d.attachment.fileId);
    try {
      d.conn?.close();
    } catch {
      /* já fechada */
    }
    d.sink.abort();
  }

  cancel(fileId: string) {
    const d = this.downloads.get(fileId);
    if (d) this.drop(d);
  }

  /** (testes) Derruba a conexão de um download em andamento, como se a rede caísse. */
  breakConnection(fileId: string) {
    const conn = this.downloads.get(fileId)?.conn;
    try {
      conn?.close();
    } catch {
      /* já fechada */
    }
  }

  stop() {
    this.stopped = true;
    for (const d of [...this.downloads.values()]) this.drop(d);
    for (const conn of this.serving) {
      try {
        conn.close();
      } catch {
        /* já fechada */
      }
    }
    this.serving.clear();
    this.files.clear();
  }

  private serve(conn: DataConnection, fileId: string, offset: number) {
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
      if (!file || !this.isMember(conn.peer) || offset > file.size) {
        conn.send(JSON.stringify({ error: 'gone' }));
        window.setTimeout(() => conn.close(), 1_000);
        return;
      }
      void this.pump(conn, file, offset, () => closed || this.stopped);
    });
  }

  private async pump(conn: DataConnection, file: File, start: number, cancelled: () => boolean) {
    conn.send(JSON.stringify({ head: { size: file.size, offset: start } }));
    const channel = conn.dataChannel;
    for (let offset = start; offset < file.size; offset += CHUNK) {
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
      if (cancelled()) return;
      conn.send(chunk);
    }
    conn.send(JSON.stringify({ end: true }));
  }
}
