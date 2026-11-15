import { useState, type ReactNode } from 'react';

/**
 * Markdown leve no estilo Discord, renderizado como elementos React (nada de innerHTML):
 * **negrito**, *itálico*, ~~riscado~~, ||spoiler||, `código`, ```bloco```, links e @menções.
 */

const CODE_BLOCK = /```(?:[\w-]*\n)?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const TOKENS =
  /(\*\*[^*\n]+?\*\*|(?<![\p{L}\p{N}])__[^_\n]+?__(?![\p{L}\p{N}])|~~[^~\n]+?~~|\|\|[^|\n]+?\|\||\*[^*\s][^*\n]*?\*|(?<![\p{L}\p{N}])_[^_\s][^_\n]*?_(?![\p{L}\p{N}])|https?:\/\/[^\s<>"']+|@[\p{L}\p{N}_.-]+)/gu;
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}(?:️|⃣|[\u{1F3FB}-\u{1F3FF}]|‍\p{Extended_Pictographic})*️?\s*){1,8}$/u;
const EVERYONE = ['todos', 'everyone', 'all'];

export const isJumbo = (text: string) => text.length <= 64 && EMOJI_ONLY.test(text.trim());

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={open ? 'md-spoiler is-open' : 'md-spoiler'}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
    >
      {children}
    </span>
  );
}

type Key = () => number;

export function renderMarkdown(text: string, mentionNames: Set<string>): ReactNode[] {
  let key = 0;
  const k: Key = () => key++;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CODE_BLOCK)) {
    const index = match.index ?? 0;
    if (index > last) out.push(...inlineCode(text.slice(last, index), mentionNames, k));
    out.push(
      <pre key={k()} className="md-pre">
        <code>{match[1].replace(/^\n+|\n+$/g, '')}</code>
      </pre>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) out.push(...inlineCode(text.slice(last), mentionNames, k));
  return out;
}

function inlineCode(text: string, names: Set<string>, k: Key): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(...tokens(text.slice(last, index), names, k, 0));
    out.push(
      <code key={k()} className="md-code">
        {match[1]}
      </code>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) out.push(...tokens(text.slice(last), names, k, 0));
  return out;
}

function tokens(text: string, names: Set<string>, k: Key, depth: number): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const inner = (value: string) => (depth < 3 ? tokens(value, names, k, depth + 1) : [value]);
  for (const match of text.matchAll(TOKENS)) {
    const index = match.index ?? 0;
    const token = match[0];
    if (index > last) out.push(text.slice(last, index));
    if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={k()}>{inner(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('~~')) {
      out.push(<s key={k()}>{inner(token.slice(2, -2))}</s>);
    } else if (token.startsWith('||')) {
      out.push(<Spoiler key={k()}>{inner(token.slice(2, -2))}</Spoiler>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(<em key={k()}>{inner(token.slice(1, -1))}</em>);
    } else if (token.startsWith('http')) {
      const [, url, trail] = token.match(/^(.*?)([.,;:!?)\]]*)$/) ?? [token, token, ''];
      out.push(
        <a key={k()} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>,
      );
      if (trail) out.push(trail);
    } else if (token.startsWith('@')) {
      const name = token.slice(1).toLowerCase();
      out.push(
        names.has(name) || EVERYONE.includes(name) ? (
          <span key={k()} className="md-mention">
            {token}
          </span>
        ) : (
          token
        ),
      );
    } else {
      out.push(token);
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Nomes que contam como menção: primeiro nome e nome completo sem espaços. */
export function mentionKeys(name: string): string[] {
  const lower = name.toLowerCase().trim();
  const first = lower.split(/\s+/)[0] ?? '';
  return [...new Set([first, lower.replace(/\s+/g, '')].filter((s) => s.length > 1))];
}

export function mentionsName(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  if (EVERYONE.some((e) => new RegExp(`@${e}(?![\\p{L}\\p{N}])`, 'u').test(lower))) return true;
  return mentionKeys(name).some((key) =>
    new RegExp(`@${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(lower),
  );
}
