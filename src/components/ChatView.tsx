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
import { Hash, ImagePlus, LoaderCircle, Menu, Orbit, Pencil, Send, Smile, SmilePlus, Trash2, UserPlus, Users, X } from 'lucide-react';
import { deleteMessage, editMessage, notifyTyping, react, sendMessage } from '../controller';
import { MAX_TEXT_LENGTH, QUICK_EMOJIS, REACTIONS } from '../lib/config';
import { imageToAttachment } from '../lib/images';
import { isJumbo, mentionKeys, mentionsName, renderMarkdown } from '../lib/markdown';
import type { Attachment, ChatMessage, Member } from '../lib/protocol';
import { errorMessage, formatDay, formatTime } from '../lib/util';
import { setApp, toast, useApp } from '../store';
import { Planet } from './Planet';
import { cx, IconButton, useNow } from './ui';

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_MEMBERS: Member[] = [];
const EMPTY_TYPING: Record<string, number> = {};
const GROUP_WINDOW_MS = 7 * 60_000;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function ChannelHeader({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  const showMembers = useApp((s) => s.showMembers);
  return (
    <header className="main-header">
      <button type="button" className="main-header__nav" onClick={() => setApp({ navOpen: true })} aria-label="Abrir canais">
        <Menu size={20} />
      </button>
      <span className="main-header__icon">{icon}</span>
      <h1 className="main-header__title">{title}</h1>
      <div className="main-header__tools">
        {children}
        <IconButton label="Convidar" tipPos="bottom" onClick={() => setApp({ modal: { kind: 'invite' } })}>
          <UserPlus size={20} />
        </IconButton>
        <IconButton
          label={showMembers ? 'Esconder membros' : 'Mostrar membros'}
          tipPos="bottom"
          active={showMembers}
          onClick={() => setApp({ showMembers: !showMembers })}
        >
          <Users size={20} />
        </IconButton>
      </div>
    </header>
  );
}

export function ChatView({ channelId }: { channelId: string }) {
  const channel = useApp((s) => s.room?.channels.find((c) => c.id === channelId));
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  if (!channel) return null;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) setDropped(file);
  };

  return (
    <section
      className="chat"
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
      <ChannelHeader icon={<Hash size={22} />} title={channel.name} />
      <MessageList channelId={channelId} channelName={channel.name} />
      <Composer channelId={channelId} channelName={channel.name} dropped={dropped} onDroppedHandled={() => setDropped(null)} />
      {dragging && <div className="drop-overlay">Solte a imagem para enviar em #{channel.name}</div>}
    </section>
  );
}

function MessageList({ channelId, channelName }: { channelId: string; channelName: string }) {
  const messages = useApp((s) => s.messages[channelId] ?? EMPTY_MESSAGES);
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
          <Hash size={34} />
        </div>
        <h2>Bem-vindo a #{channelName}!</h2>
        <p>Este é o começo do canal. As mensagens vivem só enquanto a órbita existir — nada fica em servidor.</p>
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
  mentioned: boolean;
  meId: string;
  mentionNames: Set<string>;
  onMediaLoad: () => void;
}

const MessageItem = memo(function MessageItem({ message, head, mine, canDelete, mentioned, meId, mentionNames, onMediaLoad }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const members = useApp((s) => s.room?.members ?? EMPTY_MEMBERS);

  if (message.system) {
    return (
      <div className="msg msg--system">
        <Orbit size={16} />
        <span className="msg__text">{renderMarkdown(message.text, mentionNames)}</span>
        <time>{formatTime(message.ts)}</time>
        <Reactions message={message} meId={meId} members={members} />
      </div>
    );
  }

  return (
    <div className={cx('msg', head && 'msg--head', mentioned && 'msg--mention')}>
      {head ? (
        <Planet name={message.authorName} color={message.authorColor} size={40} className="msg__avatar" />
      ) : (
        <time className="msg__hover-time">{formatTime(message.ts)}</time>
      )}
      <div className="msg__body">
        {head && (
          <div className="msg__meta">
            <span className="msg__author" style={{ color: message.authorColor }}>
              {message.authorName}
            </span>
            <time>
              {formatDay(message.ts)} às {formatTime(message.ts)}
            </time>
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
        {message.attachment && <ImageAttachment attachment={message.attachment} onLoad={onMediaLoad} />}
        <Reactions message={message} meId={meId} members={members} />
      </div>
      <div className="msg__toolbar">
        <button type="button" aria-label="Reagir" onClick={() => setPicker(!picker)}>
          <SmilePlus size={18} />
        </button>
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

function Reactions({ message, meId, members }: { message: ChatMessage; meId: string; members: Member[] }) {
  const entries = Object.entries(message.reactions ?? {});
  if (!entries.length) return null;
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

function ImageAttachment({ attachment, onLoad }: { attachment: Attachment; onLoad: () => void }) {
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

function Composer({
  channelId,
  channelName,
  dropped,
  onDroppedHandled,
}: {
  channelId: string;
  channelName: string;
  dropped: File | null;
  onDroppedHandled: () => void;
}) {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const net = useApp((s) => s.net);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const addFile = async (file: File) => {
    setBusy(true);
    try {
      setAttachment(await imageToAttachment(file));
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
    sendMessage(channelId, body, attachment ?? undefined);
    setText('');
    setAttachment(null);
    area.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
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
      {attachment && (
        <div className="composer__preview">
          <img src={attachment.dataUrl} alt={attachment.name} />
          <button type="button" aria-label="Remover imagem" onClick={() => setAttachment(null)}>
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
        <textarea
          ref={area}
          rows={1}
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          placeholder={`Conversar em #${channelName}`}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) notifyTyping(channelId);
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
      <TypingIndicator channelId={channelId} />
      {net === 'reconnecting' && <div className="composer__note">Reconectando… o que você mandar agora sai quando a órbita voltar.</div>}
    </div>
  );
}

function TypingIndicator({ channelId }: { channelId: string }) {
  const typing = useApp((s) => s.typing[channelId] ?? EMPTY_TYPING);
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
