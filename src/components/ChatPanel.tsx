import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  CornerDownRight,
  Download,
  FileText,
  ImagePlus,
  LoaderCircle,
  MessageSquare,
  Orbit,
  PanelRightClose,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Search,
  Send,
  Smile,
  SmilePlus,
  Trash2,
  X,
} from 'lucide-react';
import {
  cancelDownload,
  deleteMessage,
  downloadFile,
  editMessage,
  hasLocalFile,
  notifyTyping,
  pinMessage,
  react,
  sendMessage,
  setChatOpen,
  setChatWidth,
  setReply,
  shareFile,
} from '../controller';
import { MAX_TEXT_LENGTH, QUICK_EMOJIS, REACTIONS } from '../lib/config';
import { canDownloadSize, formatBytes, formatDuration, isRisky } from '../lib/files';
import { imageToAttachment } from '../lib/images';
import { isJumbo, mentionKeys, mentionsName, renderMarkdown } from '../lib/markdown';
import type { Attachment, ChatMessage, FileAttachment, ImageAttachment, Member } from '../lib/protocol';
import { errorMessage, formatDay, formatTime } from '../lib/util';
import { getApp, setApp, toast, useApp } from '../store';
import { Planet } from './Planet';
import { cx, IconButton, useNow } from './ui';

const EMPTY_MEMBERS: Member[] = [];
const GROUP_WINDOW_MS = 7 * 60_000;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** Imagens até este tamanho vão comprimidas no chat; acima disso (ou outros tipos), como arquivo. */
const INLINE_IMAGE_MAX = 25 * 1024 * 1024;

/** Sem acento e em minúsculas, para a busca. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Texto curto de uma mensagem (para a barra de fixadas, respostas e a busca). */
function plainOf(message: ChatMessage): string {
  const text = message.text.replace(/[*_~`>|]/g, '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  if (message.attachment?.kind === 'file') return `📎 ${message.attachment.name}`;
  if (message.attachment) return '🖼️ imagem';
  return '';
}

/** Rola até uma mensagem e pisca para chamar a atenção. */
export function jumpToMessage(id: string) {
  const run = () => {
    const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!el) {
      toast('Essa mensagem não está mais no histórico.');
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
    window.setTimeout(() => el.classList.remove('is-flash'), 1_800);
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/** O chat da sala, num painel à direita que dá para esconder. */
export function ChatPanel() {
  const roomName = useApp((s) => s.room?.name ?? '');
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) setDropped(file);
  };
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  return (
    <aside
      className="chat-panel"
      aria-label="Chat"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <ResizeHandle />
      <header className="chat-panel__head">
        <MessageSquare size={18} />
        <h2>Chat</h2>
        <IconButton label="Buscar no chat" tipPos="bottom" active={searching} onClick={() => (searching ? closeSearch() : setSearching(true))}>
          <Search size={18} />
        </IconButton>
        <IconButton label="Esconder o chat" tipPos="bottom" className="chat-panel__close" onClick={() => setChatOpen(false)}>
          <PanelRightClose size={19} />
        </IconButton>
      </header>
      {searching && (
        <div className="chat-search">
          <Search size={15} />
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="Buscar mensagens, nomes ou arquivos"
            aria-label="Buscar no chat"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
            }}
          />
          <button type="button" aria-label="Fechar a busca" onClick={closeSearch}>
            <X size={15} />
          </button>
        </div>
      )}
      <PinnedBar />
      {query.trim() ? (
        <SearchResults
          query={query.trim()}
          onPick={(id) => {
            closeSearch();
            jumpToMessage(id);
          }}
        />
      ) : (
        <MessageList roomName={roomName} />
      )}
      <Composer dropped={dropped} onDroppedHandled={() => setDropped(null)} />
      {dragging && <div className="drop-overlay">Solte para enviar no chat (imagens e arquivos até 1 GB)</div>}
    </aside>
  );
}

const MIN_CHAT = 280;
const clampChat = (width: number) => Math.round(Math.max(MIN_CHAT, Math.min(width, Math.max(MIN_CHAT, window.innerWidth / 2))));

/** Alça na borda esquerda do chat: arraste para mudar a largura, dois cliques voltam ao padrão. */
function ResizeHandle() {
  const width = useApp((s) => s.chatWidth);
  return (
    <div
      className="chat-panel__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Largura do chat"
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title="Arraste para mudar a largura · dois cliques voltam ao padrão"
      onPointerDown={(e) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('is-dragging');
        const move = (ev: PointerEvent) => setChatWidth(clampChat(window.innerWidth - ev.clientX), false);
        const up = () => {
          handle.classList.remove('is-dragging');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          const final = getApp().chatWidth;
          if (final) setChatWidth(final);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => setChatWidth(null)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const current = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 360;
        setChatWidth(clampChat(current + (e.key === 'ArrowLeft' ? 24 : -24)));
      }}
    />
  );
}

/** Mensagens fixadas pelo host: a mais recente aparece no topo; clicando, abre a lista. */
function PinnedBar() {
  const messages = useApp((s) => s.messages);
  const isHost = useApp((s) => s.isHost);
  const [open, setOpen] = useState(false);
  const pinned = useMemo(() => messages.filter((m) => m.pinnedAt).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)), [messages]);
  if (!pinned.length) return null;
  const top = pinned[0];
  return (
    <div className="pinned-bar">
      <button type="button" className="pinned-bar__main" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Pin size={15} />
        <span className="pinned-bar__text">
          <b>{top.authorName}:</b> {plainOf(top)}
        </span>
        <span className="pinned-bar__count">{pinned.length === 1 ? '1 fixada' : `${pinned.length} fixadas`}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="pinned-list" role="list">
            {pinned.map((m) => (
              <div key={m.id} className="pinned-list__item" role="listitem">
                <button
                  type="button"
                  className="pinned-list__go"
                  onClick={() => {
                    setOpen(false);
                    jumpToMessage(m.id);
                  }}
                >
                  <span className="pinned-list__author" style={{ color: m.authorColor || undefined }}>
                    {m.authorName}
                  </span>
                  <span className="pinned-list__text">{plainOf(m)}</span>
                </button>
                {isHost && (
                  <button type="button" className="pinned-list__unpin" aria-label="Desafixar" title="Desafixar" onClick={() => pinMessage(m.id, false)}>
                    <PinOff size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Marca o trecho encontrado (sem diferenciar acentos e maiúsculas). */
function highlight(text: string, query: string): ReactNode {
  const chars = Array.from(text);
  const folded = chars.map((c) => fold(c));
  const starts: number[] = [];
  let joined = '';
  for (const f of folded) {
    starts.push(joined.length);
    joined += f;
  }
  const q = fold(query);
  const at = joined.indexOf(q);
  if (at < 0) return text;
  const end = at + q.length;
  let from = starts.findIndex((st, i) => st + folded[i].length > at);
  let to = starts.findIndex((st) => st >= end);
  if (to < 0) to = chars.length;
  if (from < 0) from = 0;
  // recorta em volta do trecho, para mensagens longas
  const left = Math.max(0, from - 60);
  const right = Math.min(chars.length, to + 90);
  return (
    <>
      {left > 0 && '…'}
      {chars.slice(left, from).join('')}
      <mark>{chars.slice(from, to).join('')}</mark>
      {chars.slice(to, right).join('')}
      {right < chars.length && '…'}
    </>
  );
}

function SearchResults({ query, onPick }: { query: string; onPick: (id: string) => void }) {
  const messages = useApp((s) => s.messages);
  const q = fold(query);
  const found = messages.filter((m) => !m.system && (fold(plainOf(m)).includes(q) || fold(m.authorName).includes(q))).reverse();
  return (
    <div className="messages search-results" aria-live="polite">
      <p className="search-results__count">{found.length === 0 ? 'Nada encontrado.' : found.length === 1 ? '1 resultado' : `${found.length} resultados`}</p>
      {found.map((m) => (
        <button key={m.id} type="button" className="search-hit" onClick={() => onPick(m.id)}>
          <span className="search-hit__meta">
            <b style={{ color: m.authorColor || undefined }}>{fold(m.authorName).includes(q) ? highlight(m.authorName, query) : m.authorName}</b>
            <time>
              {formatDay(m.ts)} às {formatTime(m.ts)}
            </time>
          </span>
          <span className="search-hit__text">{fold(plainOf(m)).includes(q) ? highlight(plainOf(m), query) : plainOf(m)}</span>
        </button>
      ))}
    </div>
  );
}

function MessageList({ roomName }: { roomName: string }) {
  const messages = useApp((s) => s.messages);
  const members = useApp((s) => s.room?.members ?? EMPTY_MEMBERS);
  const meId = useApp((s) => s.meId);
  const isHost = useApp((s) => s.isHost);
  const myName = useApp((s) => s.profile.name);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const mentionNames = useMemo(() => new Set(members.flatMap((m) => mentionKeys(m.name))), [members]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const onMediaLoad = () => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };

  const items: ReactNode[] = [];
  let prev: ChatMessage | undefined;
  for (const message of messages) {
    if (!prev || !sameDay(prev.ts, message.ts)) {
      items.push(
        <div key={`d-${message.id}`} className="day-divider">
          {formatDay(message.ts)}
        </div>,
      );
    }
    const head =
      !prev ||
      !!prev.system ||
      !!message.system ||
      prev.authorId !== message.authorId ||
      message.ts - prev.ts > GROUP_WINDOW_MS ||
      !sameDay(prev.ts, message.ts);
    const mine = message.authorId === meId;
    items.push(
      <MessageItem
        key={message.id}
        message={message}
        head={head}
        mine={mine}
        canDelete={mine || isHost}
        isHost={isHost}
        mentioned={!mine && !message.system && mentionsName(message.text, myName)}
        meId={meId ?? ''}
        mentionNames={mentionNames}
        onMediaLoad={onMediaLoad}
      />,
    );
    prev = message;
  }

  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      <div className="chan-welcome">
        <div className="chan-welcome__icon">
          <MessageSquare size={30} />
        </div>
        <h2>Chat de {roomName}</h2>
        <p>As mensagens vivem só enquanto a órbita existir. Nada fica salvo em servidor.</p>
      </div>
      {items}
    </div>
  );
}

interface MessageItemProps {
  message: ChatMessage;
  head: boolean;
  mine: boolean;
  canDelete: boolean;
  isHost: boolean;
  mentioned: boolean;
  meId: string;
  mentionNames: Set<string>;
  onMediaLoad: () => void;
}

const MessageItem = memo(function MessageItem({ message, head, mine, canDelete, isHost, mentioned, meId, mentionNames, onMediaLoad }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);

  if (message.system) {
    return (
      <div className="msg msg--system" data-msg-id={message.id}>
        <Orbit size={16} />
        <span className="msg__text">{renderMarkdown(message.text, mentionNames)}</span>
        <time>{formatTime(message.ts)}</time>
        <Reactions message={message} meId={meId} />
      </div>
    );
  }

  // uma resposta sempre mostra a foto e o nome (a citação fica em cima)
  const withHead = head || !!message.replyTo;
  return (
    <div className={cx('msg', withHead && 'msg--head', mentioned && 'msg--mention', !!message.pinnedAt && 'msg--pinned')} data-msg-id={message.id}>
      {message.replyTo && (
        <button type="button" className="msg__reply" onClick={() => jumpToMessage(message.replyTo!.id)} title="Ir para a mensagem respondida">
          <CornerDownRight size={14} />
          <b>{message.replyTo.authorName}</b>
          <span>{message.replyTo.text.replace(/[*_~`>|]/g, '')}</span>
        </button>
      )}
      {withHead ? (
        <Planet memberId={message.authorId} name={message.authorName} color={message.authorColor} size={36} className="msg__avatar" />
      ) : (
        <time className="msg__hover-time">{formatTime(message.ts)}</time>
      )}
      <div className="msg__body">
        {withHead && (
          <div className="msg__meta">
            <span className="msg__author" style={{ color: message.authorColor }}>
              {message.authorName}
            </span>
            <time>
              {formatDay(message.ts)} às {formatTime(message.ts)}
            </time>
            {message.pinnedAt && (
              <span className="msg__pin" title="Fixada pelo host">
                <Pin size={12} /> fixada
              </span>
            )}
          </div>
        )}
        {editing ? (
          <EditBox
            initial={message.text}
            onCancel={() => setEditing(false)}
            onSave={(text) => {
              editMessage(message.id, text);
              setEditing(false);
            }}
          />
        ) : (
          message.text && (
            <div className={cx('msg__text', isJumbo(message.text) && 'is-jumbo')}>
              {renderMarkdown(message.text, mentionNames)}
              {message.editedAt && <span className="msg__edited">(editada)</span>}
            </div>
          )
        )}
        {message.attachment?.kind === 'image' && <ImageAttachmentView attachment={message.attachment} onLoad={onMediaLoad} />}
        {message.attachment?.kind === 'file' && <FileCard attachment={message.attachment} />}
        <Reactions message={message} meId={meId} />
      </div>
      <div className="msg__toolbar">
        <button type="button" aria-label="Reagir" onClick={() => setPicker(!picker)}>
          <SmilePlus size={18} />
        </button>
        <button type="button" aria-label="Responder" onClick={() => setReply(message.id)}>
          <Reply size={17} />
        </button>
        {isHost && (
          <button type="button" aria-label={message.pinnedAt ? 'Desafixar' : 'Fixar'} onClick={() => pinMessage(message.id, !message.pinnedAt)}>
            {message.pinnedAt ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
        )}
        {mine && !editing && (
          <button type="button" aria-label="Editar" onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </button>
        )}
        {canDelete && (
          <button type="button" aria-label="Apagar" className="danger" onClick={() => deleteMessage(message.id)}>
            <Trash2 size={16} />
          </button>
        )}
        {picker && (
          <div className="reaction-picker" onMouseLeave={() => setPicker(false)}>
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  react(message.id, emoji);
                  setPicker(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/** Só as mensagens com reação acompanham a lista de pessoas (para os nomes no balão). */
function Reactions({ message, meId }: { message: ChatMessage; meId: string }) {
  const entries = Object.entries(message.reactions ?? {});
  if (!entries.length) return null;
  return <ReactionList message={message} meId={meId} entries={entries} />;
}

function ReactionList({ message, meId, entries }: { message: ChatMessage; meId: string; entries: Array<[string, string[]]> }) {
  const members = useApp((s) => s.room?.members ?? EMPTY_MEMBERS);
  return (
    <div className="reactions">
      {entries.map(([emoji, ids]) => (
        <button
          key={emoji}
          type="button"
          className={cx('reaction', ids.includes(meId) && 'is-mine')}
          title={ids.map((id) => members.find((m) => m.id === id)?.name ?? 'alguém').join(', ')}
          onClick={() => react(message.id, emoji)}
        >
          {emoji} <span>{ids.length}</span>
        </button>
      ))}
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="edit-box">
      <textarea
        autoFocus
        value={text}
        maxLength={MAX_TEXT_LENGTH}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onSave(text.trim());
          }
        }}
      />
      <span className="edit-box__hint">Esc para cancelar · Enter para salvar</span>
    </div>
  );
}

/** Arquivo enviado no chat: fica no computador de quem mandou; baixa direto dele. */
function FileCard({ attachment }: { attachment: FileAttachment }) {
  const transfer = useApp((s) => s.transfers[attachment.fileId]);
  const ownerHere = useApp((s) => !!s.room?.members.some((m) => m.id === attachment.ownerId && !m.reconnecting));
  const mine = hasLocalFile(attachment.fileId);
  const downloading = transfer?.status === 'downloading' || transfer?.status === 'retrying';
  const gone = !mine && (!ownerHere || (transfer?.status === 'error' && transfer.reason === 'gone'));
  const tooBig = !mine && !canDownloadSize(attachment.size);
  const pct = downloading && attachment.size ? Math.floor((transfer.received / attachment.size) * 100) : 0;
  const speed = transfer?.speed ?? 0;
  const eta = speed > 0 ? formatDuration((attachment.size - (transfer?.received ?? 0)) / speed) : '';
  const status = mine
    ? 'fica disponível enquanto você estiver na órbita'
    : gone
      ? 'arquivo indisponível (quem mandou saiu da órbita)'
      : tooBig
        ? 'grande demais para este navegador: abra no Chrome, Edge ou Brave'
        : transfer?.status === 'retrying'
          ? `a conexão caiu, voltando… (${pct}%, continua de onde parou)`
          : downloading
            ? `baixando… ${pct}%${speed > 0 ? ` · ${formatBytes(speed)}/s · falta ${eta}` : ''}`
            : transfer?.status === 'done'
              ? 'baixado'
              : transfer?.status === 'error'
                ? 'a transferência caiu, tente de novo'
                : 'baixa direto do computador de quem mandou';
  return (
    <div className={cx('file-card', gone && 'is-gone')}>
      <FileText size={28} className="file-card__icon" />
      <div className="file-card__info">
        <span className="file-card__name" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="file-card__meta">
          {formatBytes(attachment.size)} · {status}
        </span>
        {!mine && isRisky(attachment.name) && <span className="file-card__warn">⚠️ Programa ou script: só abra se confiar em quem mandou.</span>}
        {downloading && (
          <span className="file-card__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      {downloading ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => cancelDownload(attachment.fileId)}>
          Cancelar
        </button>
      ) : (
        <button type="button" className="btn btn--sm" disabled={gone || tooBig} onClick={() => void downloadFile(attachment)}>
          <Download size={14} /> {mine ? 'Salvar' : gone ? 'Indisponível' : 'Baixar'}
        </button>
      )}
    </div>
  );
}

function ImageAttachmentView({ attachment, onLoad }: { attachment: ImageAttachment; onLoad: () => void }) {
  if (!attachment.dataUrl) {
    return <div className="attachment attachment--expired">🖼️ {attachment.name} — imagem antiga (o host não guarda imagens velhas para quem entra depois)</div>;
  }
  const ratio = attachment.width / attachment.height;
  return (
    <button
      type="button"
      className="attachment"
      onClick={() => setApp({ modal: { kind: 'image', src: attachment.dataUrl, name: attachment.name } })}
    >
      <img
        src={attachment.dataUrl}
        alt={attachment.name}
        loading="lazy"
        style={{ aspectRatio: Number.isFinite(ratio) && ratio > 0 ? String(ratio) : undefined }}
        onLoad={onLoad}
      />
    </button>
  );
}

function Composer({ dropped, onDroppedHandled }: { dropped: File | null; onDroppedHandled: () => void }) {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const net = useApp((s) => s.net);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const anyFileInput = useRef<HTMLInputElement>(null);
  const replyId = useApp((s) => s.replyTo);
  const replying = useApp((s) => (s.replyTo ? s.messages.find((m) => m.id === s.replyTo) : undefined));

  useEffect(() => {
    if (replyId) area.current?.focus();
  }, [replyId]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    // com o painel escondido a altura medida é 0: deixa o CSS decidir
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  /** Imagens vão comprimidas no chat; o resto (ou imagem enorme) vai como arquivo, direto do meu computador. */
  const addFile = async (file: File, asFile = false) => {
    setBusy(true);
    try {
      const inline = !asFile && file.type.startsWith('image/') && file.size <= INLINE_IMAGE_MAX;
      setAttachment(inline ? await imageToAttachment(file) : shareFile(file));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!dropped) return;
    void addFile(dropped);
    onDroppedHandled();
  }, [dropped, onDroppedHandled]);

  const send = () => {
    const body = text.trim();
    if (!body && !attachment) return;
    sendMessage(body, attachment ?? undefined);
    setText('');
    setAttachment(null);
    area.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && replyId) {
      e.preventDefault();
      setReply(null);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void addFile(file);
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  return (
    <div className="composer-wrap">
      {replying && (
        <div className="composer__reply">
          <Reply size={14} />
          <span>
            Respondendo a <b>{replying.authorName}</b>: {plainOf(replying)}
          </span>
          <button type="button" aria-label="Cancelar a resposta" onClick={() => setReply(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {attachment?.kind === 'image' && (
        <div className="composer__preview">
          <img src={attachment.dataUrl} alt={attachment.name} />
          <button type="button" aria-label="Remover imagem" onClick={() => setAttachment(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {attachment?.kind === 'file' && (
        <div className="composer__file">
          <FileText size={18} />
          <span className="composer__file-name">{attachment.name}</span>
          <span className="muted">{formatBytes(attachment.size)}</span>
          <button type="button" aria-label="Remover arquivo" onClick={() => setAttachment(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="composer">
        <button
          type="button"
          className="composer__btn"
          aria-label="Enviar imagem"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? <LoaderCircle size={20} className="spin" /> : <ImagePlus size={20} />}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void addFile(file);
            e.target.value = '';
          }}
        />
        <button type="button" className="composer__btn" aria-label="Enviar arquivo (até 1 GB)" disabled={busy} onClick={() => anyFileInput.current?.click()}>
          <Paperclip size={19} />
        </button>
        <input
          ref={anyFileInput}
          type="file"
          hidden
          aria-label="Escolher arquivo"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void addFile(file, true);
            e.target.value = '';
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          placeholder="Mensagem"
          aria-label="Mensagem"
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) notifyTyping();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer__emoji">
          <button type="button" className="composer__btn" aria-label="Emojis" onClick={() => setEmojiOpen(!emojiOpen)}>
            <Smile size={20} />
          </button>
          {emojiOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setEmojiOpen(false)} />
              <div className="emoji-picker">
                {QUICK_EMOJIS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button type="button" className="composer__btn composer__send" aria-label="Enviar" disabled={!text.trim() && !attachment} onClick={send}>
          <Send size={18} />
        </button>
      </div>
      <TypingIndicator />
      {net === 'reconnecting' && <div className="composer__note">Reconectando… o que você mandar agora sai quando a órbita voltar.</div>}
    </div>
  );
}

function TypingIndicator() {
  const typing = useApp((s) => s.typing);
  const members = useApp((s) => s.room?.members ?? EMPTY_MEMBERS);
  const meId = useApp((s) => s.meId);
  const now = useNow(1_000);
  const names = Object.entries(typing)
    .filter(([id, expires]) => expires > now && id !== meId)
    .map(([id]) => members.find((m) => m.id === id)?.name)
    .filter((name): name is string => !!name);
  if (!names.length) return <div className="typing" />;
  const label =
    names.length === 1
      ? `${names[0]} está digitando`
      : names.length === 2
        ? `${names[0]} e ${names[1]} estão digitando`
        : 'Várias pessoas estão digitando';
  return (
    <div className="typing">
      <span className="typing__dots">
        <i />
        <i />
        <i />
      </span>
      {label}…
    </div>
  );
}
