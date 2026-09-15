// Flattens a Claude Code session transcript into events. The format is undocumented and changes, so
// anything unrecognised is skipped, never fatal.

import { readFileSync } from 'node:fs';

/** One thing from the transcript, flattened. */
export interface SessionEvent {
  /** 'tool-result' says whether a call succeeded; 'user-meta' is an AskUserQuestion answer. */
  kind: 'text' | 'tool' | 'tool-result' | 'user' | 'user-meta';
  line: number;
  /** Assistant prose, a user message, or an answer's text. */
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** Joins a 'tool' call to its 'tool-result'. */
  toolUseId?: string;
  ok?: boolean;
  /** The record's working directory, to resolve a relative file path against. */
  cwd?: string;
  /** A user record's text blocks, unjoined: extract.ts strips harness blocks one at a time. */
  parts?: string[];
  /** Images attached to a user message, and how many had no bytes in the transcript to save. */
  images?: { mediaType: string; data: string }[];
  imagesUnsaved?: number;
}

export interface ParsedSession {
  events: SessionEvent[];
  /** Lines that were not JSON. Counted, because a session killed mid-write loses its last message there. */
  unreadable: number[];
}

/** Pull a usable assistant `content` array out of one transcript record, or null. */
function assistantContent(rec: unknown): unknown[] | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;

  // { type:'assistant', message:{ role:'assistant', content:[...] } }
  const msg = r.message;
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    if ((m.role === 'assistant' || r.type === 'assistant') && Array.isArray(m.content)) {
      return m.content;
    }
  }

  // A flattened record may put the content at the top level.
  if ((r.role === 'assistant' || r.type === 'assistant') && Array.isArray(r.content)) {
    return r.content;
  }

  return null;
}

/** The `content` array of any record: tool_use blocks ride on assistant records, tool_result blocks on user ones. */
function anyContent(rec: unknown): unknown[] | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  const msg = r.message;
  if (msg && typeof msg === 'object' && Array.isArray((msg as Record<string, unknown>).content)) {
    return (msg as Record<string, unknown>).content as unknown[];
  }
  if (Array.isArray(r.content)) return r.content;
  return null;
}

/** An assistant record's text and tool_use blocks, as events. */
function blocksToEvents(content: unknown[], line: number, cwd?: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      // Tolerate a bare string content entry: treat as text.
      if (typeof block === 'string' && block.trim()) {
        out.push({ kind: 'text', line, text: block });
      }
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ kind: 'text', line, text: b.text });
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({
        kind: 'tool',
        line,
        toolName: b.name,
        toolInput:
          b.input && typeof b.input === 'object'
            ? (b.input as Record<string, unknown>)
            : {},
        toolUseId: typeof b.id === 'string' ? b.id : undefined,
        cwd,
      });
    }
  }
  return out;
}

/** The working directory a transcript record was written from, if it carries one. */
function recordCwd(rec: unknown): string | undefined {
  if (!rec || typeof rec !== 'object') return undefined;
  const c = (rec as Record<string, unknown>).cwd;
  return typeof c === 'string' && c ? c : undefined;
}

/** A subagent's turn. Its text and tool calls are not the main agent's. */
function isSidechain(rec: unknown): boolean {
  return !!rec && typeof rec === 'object' && (rec as Record<string, unknown>).isSidechain === true;
}

/**
 * A message the user sent: a user record with text or images that is not isMeta, not a compaction
 * summary, and not only a tool result. When unsure it counts the turn, since an extra message is
 * visible and a lost one is not.
 */
function userTurnEvent(rec: unknown, line: number): SessionEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  // Slash-command expansions and hook plumbing. Real answers arrive through askConsentEvents.
  if (r.isMeta === true) return null;
  // A compaction summary is machine text in a user-role record.
  if (r.isCompactSummary === true) return null;
  const msg = r.message;
  const role =
    msg && typeof msg === 'object' ? (msg as Record<string, unknown>).role : undefined;
  if (r.type !== 'user' && role !== 'user') return null;
  const content =
    msg && typeof msg === 'object' ? (msg as Record<string, unknown>).content : r.content;
  if (typeof content === 'string')
    return content.trim() ? { kind: 'user', line, text: content } : null;
  if (!Array.isArray(content)) return null;
  // Every text block, handed on raw in `parts`, so the one list of harness tags in extract.ts
  // decides which of them are machine text.
  const parts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  let unsaved = 0;
  // An image inside a tool result belongs to the tool, not the user.
  const carriesResult = content.some((b) => !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result');
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
    else if (b.type === 'image' && !carriesResult) {
      const img = imageOf(b);
      // An image without its bytes is counted, so the message still says the user showed something.
      if (img) images.push(img); else unsaved++;
    }
  }
  // Catches a summary with no flag. Anchored at the head, so a user asking about compaction keeps
  // their message.
  if (parts.length && COMPACT_SUMMARY_OPENER.test(parts[0])) return null;
  if (!parts.length && !images.length && !unsaved) return null;
  // Blocks joined by a blank line, so two parts never read as one sentence.
  return {
    kind: 'user', line, text: parts.join('\n\n'), parts,
    ...(images.length ? { images } : {}),
    ...(unsaved ? { imagesUnsaved: unsaved } : {}),
  };
}

/** How Claude Code opens the summary it writes in the user's place when it squeezes the context. */
const COMPACT_SUMMARY_OPENER = /^\s*This session is being continued from a previous conversation/i;

/** An attached image as Claude Code stores it inline, or null for any other shape. */
function imageOf(b: Record<string, unknown>): { mediaType: string; data: string } | null {
  const s = b.source;
  if (!s || typeof s !== 'object') return null;
  const src = s as Record<string, unknown>;
  if (src.type !== 'base64' || typeof src.data !== 'string' || !src.data || typeof src.media_type !== 'string') return null;
  return { mediaType: src.media_type, data: src.data };
}

/**
 * A message typed while the agent was mid-turn, recorded as a `queued_command` attachment rather
 * than a user record. `queue-operation` records are not read: they include messages cancelled
 * before delivery.
 */
function queuedUserEvent(rec: unknown, line: number): SessionEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.type !== 'attachment') return null;
  const att = r.attachment;
  if (!att || typeof att !== 'object') return null;
  const a = att as Record<string, unknown>;
  if (a.type !== 'queued_command') return null;
  // A string when typed, an array of blocks when an image came with it.
  const parts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  let unsaved = 0;
  if (typeof a.prompt === 'string') {
    if (a.prompt.trim()) parts.push(a.prompt);
  } else if (Array.isArray(a.prompt)) {
    for (const block of a.prompt) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
      else if (b.type === 'image') { const img = imageOf(b); if (img) images.push(img); else unsaved++; }
    }
  }
  const text = parts.join('\n\n').trim();
  if (!text && !images.length && !unsaved) return null;
  const shots = { ...(images.length ? { images } : {}), ...(unsaved ? { imagesUnsaved: unsaved } : {}) };
  const queued = (): SessionEvent => ({ kind: 'user', line, text, parts, ...shots });
  // `origin.kind`, when present, settles authorship. Without it, the shape of the text decides.
  const origin = a.origin;
  const originKind =
    origin && typeof origin === 'object' ? (origin as Record<string, unknown>).kind : undefined;
  if (typeof originKind === 'string') {
    return originKind === 'human' ? queued() : null;
  }
  return HARNESS_QUEUED.test(text) ? null : queued();
}

/** Harness blocks that arrive through the same queue. Anchored, so a message that mentions a tag still counts. */
const HARNESS_QUEUED =
  /^<(?:task-notification|system-reminder|local-command|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|tool|output)\b/i;

/** Whitespace-normalised text, the dedupe key for a queued message vs its delivered twin. */
function normText(t: string | undefined): string {
  return (t ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * How many lines apart a queued record and its delivered twin can be. A twin sits beside its twin;
 * the same words sent again later are a new message.
 */
const TWIN_WINDOW = 40;

/**
 * Folds queued messages into the events, dropping one only when the same message was delivered as a
 * user record nearby. The delivered record wins, since it holds the true position.
 */
function mergeQueued(events: SessionEvent[], queued: SessionEvent[]): SessionEvent[] {
  if (!queued.length) return events;
  // text -> the lines where that text already appears, so proximity can be tested.
  const seen = new Map<string, number[]>();
  for (const e of events) {
    if (e.kind !== 'user' && e.kind !== 'user-meta') continue;
    const k = normText(e.text);
    if (k) (seen.get(k) ?? seen.set(k, []).get(k)!).push(e.line);
  }
  const near = (k: string, line: number): boolean =>
    (seen.get(k) ?? []).some((l) => Math.abs(l - line) <= TWIN_WINDOW);
  const add: SessionEvent[] = [];
  for (const q of queued) {
    const key = normText(q.text);
    if (!key || near(key, q.line)) continue;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(q.line);
    add.push(q);
  }
  if (!add.length) return events;
  // Stable sort by line keeps every other event's relative order intact.
  return [...events, ...add].sort((x, y) => x.line - y.line);
}

/** Whether earlier tool calls succeeded, from tool_result blocks. */
function toolResultEvents(content: unknown[], line: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({ kind: 'tool-result', line, toolUseId: b.tool_use_id, ok: b.is_error !== true });
    }
  }
  return out;
}

/** Flatten a tool_result's content (string, or an array of {type:'text'}) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
        ? ((b as Record<string, unknown>).text as string)
        : '',
    )
    .join(' ')
    .trim();
}

/**
 * AskUserQuestion answers, which arrive as tool results. `askIds` collects the question call ids in
 * stream order, since a call always comes before its result.
 */
function askConsentEvents(rec: unknown, line: number, askIds: Set<string>): SessionEvent[] {
  if (!rec || typeof rec !== 'object') return [];
  const ac = assistantContent(rec);
  if (ac) {
    for (const b of ac) {
      if (b && typeof b === 'object') {
        const bb = b as Record<string, unknown>;
        if (bb.type === 'tool_use' && bb.name === 'AskUserQuestion' && typeof bb.id === 'string')
          askIds.add(bb.id);
      }
    }
  }
  if (askIds.size === 0) return [];
  const content = anyContent(rec);
  if (!content) return [];
  const out: SessionEvent[] = [];
  const blocks = content.filter((b) => {
    if (!b || typeof b !== 'object') return false;
    const bb = b as Record<string, unknown>;
    return bb.type === 'tool_result' && typeof bb.tool_use_id === 'string' && askIds.has(bb.tool_use_id);
  }) as Record<string, unknown>[];
  for (const bb of blocks) {
    const text = toolResultText(bb.content);
    if (text) out.push({ kind: 'user-meta', line, text });
  }
  return out;
}

/**
 * Parses a JSONL transcript into events. Subagent turns are dropped unless `includeSidechain` is set,
 * which is how a subagent's own transcript is read.
 */
export function parseSessionLog(logPath: string, opts?: { includeSidechain?: boolean }): ParsedSession {
  const keepSidechain = opts?.includeSidechain === true;
  const raw = readFileSync(logPath, 'utf8');
  const events: SessionEvent[] = [];
  // Held aside so mergeQueued can drop the ones also delivered as user records.
  const queued: SessionEvent[] = [];
  // AskUserQuestion call ids, so a later answer can be recognised.
  const askIds = new Set<string>();
  const unreadable: number[] = [];

  const lines = raw.split('\n');
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const text = rawLine.trim();
    if (!text) return;
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      unreadable.push(line);
      return;
    }
    if (!keepSidechain && isSidechain(rec)) return;
    const content = assistantContent(rec);
    if (content) {
      events.push(...blocksToEvents(content, line, recordCwd(rec)));
    }
    const ac = anyContent(rec);
    if (ac) events.push(...toolResultEvents(ac, line));
    const u = userTurnEvent(rec, line);
    if (u) events.push(u);
    const q = queuedUserEvent(rec, line);
    if (q) queued.push(q);
    events.push(...askConsentEvents(rec, line, askIds));
  });

  return { events: mergeQueued(events, queued), unreadable };
}
