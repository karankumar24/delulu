// delulu engine — session log tail.
//
// Reads a Claude Code session log and flattens it into events for the two CLI commands.
// FIVE kinds, and every one of them has a reader in handoff.ts: assistant TEXT, assistant TOOL
// CALLS and their RESULTS, real user turns, and AskUserQuestion answers.
//
// It produced seven until the cleanup. 'stop-hook' and 'compact' were parsed, tested and shipped
// for readers that dd98c8e and f7205a1 deleted — and unconsumed parsing code ROTS SILENTLY: this
// schema is undocumented and changes, nothing exercised those paths, so if the record shape had
// moved, their tests would have stayed green against our own fixtures and said nothing. If a
// feature ever needs those records, re-derive them from a CURRENT transcript; do not restore the
// old parser from git and trust its green checkmark.
//
// Two input shapes are supported, on purpose:
//   (a) a real CC transcript: ~/.claude/projects/<slug>/<sessionId>.jsonl
//       — one JSON object per line; assistant turns look like
//         {type:'assistant', message:{role:'assistant', content:[
//            {type:'text', text:'...'}, {type:'tool_use', name, input}]}}
//   (b) a fixture log: a small .jsonl/.json file we control for tests.
//
// The CC on-disk schema is undocumented and changes; we MUST tolerate unknown
// shapes rather than throw. Anything we can't parse is skipped, not fatal.

import { readFileSync } from 'node:fs';

/** A single thing the agent emitted, flattened from the transcript. */
export interface SessionEvent {
  /**
   * 'text'        = assistant prose;
   * 'tool'        = a tool_use call (Write/Edit/Bash...);
   * 'tool-result' = the RESULT of a tool_use (success/error) — the transcript's
   *                 own ground-truth of whether the action actually worked;
   * 'user'        = a REAL user turn (typed text — not a tool_result carrier, not
   *                 an isMeta record). This is the spine of IN YOUR WORDS. It was
   *                 originally needed by the promise-skip check, deleted in dd98c8e;
   *                 the events outlived the check that motivated them;
   * 'user-meta'   = an AskUserQuestion answer, surfaced by askConsentEvents. This
   *                 entry used to say isMeta user records were re-emitted here so the
   *                 ask-first guard could read them; that was FALSE from the moment
   *                 userTurnEvent started dropping every isMeta record (see the note
   *                 there — the route was printing machine text as the user's verbatim
   *                 words). An isMeta record now produces no 'user' event. It can still
   *                 produce a 'tool-result' or an answer, because toolResultEvents and
   *                 askConsentEvents do not test isMeta — measured 0 of 201 isMeta
   *                 records on this machine carry one, so the distinction is currently
   *                 academic, but "nothing at all" is the wrong claim.
   */
  kind: 'text' | 'tool' | 'tool-result' | 'user' | 'user-meta';
  /** 1-based line number in the source log (for "show me where"). */
  line: number;
  /** For kind:'text' — the assistant prose. For kind:'user' — the typed text the
   *  human actually sent, which is what IN YOUR WORDS quotes. */
  text?: string;
  /** For kind:'tool' — the tool name (Write, Edit, Bash, ...). */
  toolName?: string;
  /** For kind:'tool' — the tool input object (file_path, command, ...). */
  toolInput?: Record<string, unknown>;
  /** Join key linking a 'tool' call to its 'tool-result' (CC `tool_use_id`). */
  toolUseId?: string;
  /** For kind:'tool-result' — did the tool succeed? (false iff is_error). */
  ok?: boolean;
    /**
   * The working directory the record was written from, when the transcript carries one.
   *
   * Needed because a tool's `file_path` may be RELATIVE. Without the cwd to resolve against,
   * `./a/../a.ts` and `/repo/a.ts` are two different strings for one file — so the same file was
   * counted twice in "Files touched", while a relative path failed the repo-prefix test and
   * vanished from the block entirely. Both errors at once, in the block labelled engine-verified.
   */
  cwd?: string;
  /**
   * For kind:'user' — the record's text blocks, unjoined, in order.
   *
   * `text` is these joined, and every consumer that just wants the message reads that. This exists
   * for the ONE caller that must classify them individually: a record can mix a harness envelope
   * and the human's typed words as SEPARATE blocks, and the wrapper strip in `userUtterances` is
   * head-anchored, so a joined string only ever loses the envelope that happens to be first. Any
   * later one leaks into the block that promises the user's own words.
   *
   * The blocks stay raw here on purpose. Deciding which of them is machine text needs the harness
   * tag list, and there is exactly one of those (`KNOWN_WRAPPERS`, with the corpus history behind
   * it). Keeping the engine ignorant of harness tags is what stops a second list existing to drift
   * out of step with the first.
   */
  parts?: string[];
}

export interface ParsedSession {
  events: SessionEvent[];
  /**
   * Transcript lines that could not be parsed, by line number.
   *
   * Skipping them is right — one bad line must not cost the whole capture — but skipping them
   * SILENTLY was not, because the block they feed is headed "every message you sent". The shape
   * that matters is a session killed mid-write, which leaves a truncated final record: the reader
   * drops it, and the message lost is the LAST one, in the session delulu exists to rescue.
   */
  unreadable: number[];
}

/** Pull a usable assistant `content` array out of one transcript record, or null. */
function assistantContent(rec: unknown): unknown[] | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;

  // Shape (a): { type:'assistant', message:{ role:'assistant', content:[...] } }
  const msg = r.message;
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    if ((m.role === 'assistant' || r.type === 'assistant') && Array.isArray(m.content)) {
      return m.content;
    }
  }

  // Shape (b) tolerance: a flattened fixture record may put content at top level,
  // e.g. { role:'assistant', content:[...] } or { type:'assistant', content:[...] }.
  if ((r.role === 'assistant' || r.type === 'assistant') && Array.isArray(r.content)) {
    return r.content;
  }

  return null;
}

/**
 * Pull ANY `content` array out of a record regardless of role (assistant OR user).
 * tool_use blocks live on assistant records; tool_result blocks live on the
 * following user record — we need both.
 */
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

/** Flatten one assistant content block into SessionEvents (text + tool_use). */
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
    // unknown block types are ignored, never fatal.
  }
  return out;
}

/** The working directory a transcript record was written from, if it carries one. */
function recordCwd(rec: unknown): string | undefined {
  if (!rec || typeof rec !== 'object') return undefined;
  const c = (rec as Record<string, unknown>).cwd;
  return typeof c === 'string' && c ? c : undefined;
}

/**
 * A subagent (sidechain) turn. CC marks these `isSidechain:true`. Their text/tool
 * calls belong to a subagent, NOT the main agent — attributing a subagent's writes to the main
 * agent would misreport who touched what in STATE. Drop them entirely.
 */
function isSidechain(rec: unknown): boolean {
  return !!rec && typeof rec === 'object' && (rec as Record<string, unknown>).isSidechain === true;
}

/**
 * Is this record a REAL user turn — the human typing? True only for a user-role
 * record carrying actual text (a content string or a {type:'text'} block) that is
 * not an isMeta record (slash-command expansions / hook plumbing). tool_result
 * carriers (CC rides tool results on user records) are NOT user turns. We err toward COUNTING a
 * turn: a spurious extra message in IN YOUR WORDS is visible and harmless, a missing one is
 * invisible and breaks the block's whole promise.
 */
function userTurnEvent(rec: unknown, line: number): SessionEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  // An isMeta record is a slash-command expansion or hook plumbing — never the human typing.
  //
  // It used to be re-emitted as 'user-meta' so the (now deleted) ask-first guard could see "the
  // user asked via /commit". Nothing consumes it for that any more, and it had become a direct
  // route for machine text to be printed as the user's verbatim words: a /codex skill expansion
  // containing a shell script matched the `"x"="y"` answer shape and rendered as
  // `_(your own words, not one of the options offered)_ "124" ]; then _gstack_codex_log_event …`
  // under the strongest authority tag the payload has.
  //
  // Real AskUserQuestion answers do NOT come through here: they arrive as tool_result blocks whose
  // id matches a real AskUserQuestion call, handled by askConsentEvents. Measured across 589 real
  // answer records on this machine: ZERO carry isMeta. So dropping this loses no decision.
  if (r.isMeta === true) return null;
  const msg = r.message;
  const role =
    msg && typeof msg === 'object' ? (msg as Record<string, unknown>).role : undefined;
  if (r.type !== 'user' && role !== 'user') return null;
  const content =
    msg && typeof msg === 'object' ? (msg as Record<string, unknown>).content : r.content;
  if (typeof content === 'string')
    return content.trim() ? { kind: 'user', line, text: content } : null;
  if (!Array.isArray(content)) return null;
  // EVERY text block, in order — this used to return on the first one and throw the rest away.
  //
  // One record is ONE message: the blocks are the parts the human sent together, so keeping only
  // the first deleted the rest with no note anywhere. The shape that made it lethal is a harness
  // block sitting FIRST: content `[{text:'<system-reminder>…</system-reminder>'}, {text:'never
  // deploy on friday'}]` carried the reminder into the winner slot, `userUtterances` recognised it
  // as a wrapper with nothing after it, and the typed message was both deleted AND reported to the
  // user as "1 non-message record filtered (command plumbing, harness blocks)". Two plain blocks
  // lost the second one in silence, under a heading reading "every message you sent".
  //
  // JOINED, not filtered here, and that is the deliberate half. The obvious alternative — pick the
  // block that "looks human" — would put a SECOND harness classifier in this file, next to the one
  // `userUtterances` already owns (KNOWN_WRAPPERS + unwrapUserProse), and two lists of harness tags
  // drift apart the moment Claude Code adds a tag to one of them. Handing over the whole record
  // instead means the existing single path strips the leading `<system-reminder>…</system-reminder>`
  // and keeps the words after it, exactly as it already does when the harness inlines the reminder
  // into one block — which, measured across 855 transcripts on this machine, is the only way it has
  // ever actually done it (0 records here carry more than one text block at all, so this is a
  // reachable path with no local instance, and the corpus cannot say which order a future one
  // arrives in).
  //
  // The blocks are handed on RAW, in `parts` above, and `userUtterances` strips each at its own
  // head. An earlier version of this joined them and let the single head-anchored strip see only
  // the first, so a harness envelope in any later block printed inside the block that promises the
  // user's own words. The trade this file still keeps, for anything no list recognises: a leaked
  // tag is VISIBLE and merely annoying, a deleted message is INVISIBLE and is the one thing "in
  // your own words" must never do.
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
    // Non-text blocks (image, document, tool_result) are skipped, never fatal — a record whose
    // only text sits after an attached screenshot still counts as the user speaking.
  }
  // Blank line between blocks: they are separate parts of one message, and the reader of the
  // handoff should not see two of them fused into a sentence neither of them is.
  return parts.length ? { kind: 'user', line, text: parts.join('\n\n'), parts } : null;
}

/**
 * A message the user typed WHILE the agent was mid-turn. Claude Code queues those and
 * records them as an `attachment` of type 'queued_command' (the text lives in
 * `attachment.prompt`) — NOT as a `type:'user'` record. A parser that reads only user
 * records therefore loses them silently, and they are the HIGHEST-value class of turn:
 * mid-turn interjections are corrections and redirections ("stop, do X instead").
 *
 * Measured on this corpus before the fix: 111 of 324 substantive queued messages (34%)
 * appeared in NO user record at all — invisible to every consumer of this parser,
 * including the handoff's "verbatim, engine-extracted" block and its line-map.
 *
 * `queue-operation` records are deliberately NOT read: their `enqueue` entries include
 * messages the user cancelled before delivery, while `queued_command` fires on actual
 * delivery. Reading both would resurrect messages that were never sent.
 */
function queuedUserEvent(rec: unknown, line: number): SessionEvent | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.type !== 'attachment') return null;
  const att = r.attachment;
  if (!att || typeof att !== 'object') return null;
  const a = att as Record<string, unknown>;
  if (a.type !== 'queued_command' || typeof a.prompt !== 'string') return null;
  const text = a.prompt.trim();
  if (!text) return null;
  // Provenance first: newer records carry `origin.kind`, which settles authorship outright.
  // Re-measured 2026-09-01 across 86 transcripts on this machine (was 68): 160/160 records WITH
  // an origin are kind:'human', and 412/412 records WITHOUT one are harness blocks — every single
  // one a `<task-notification>`. So trust the field when present — it rescues a genuine message
  // that merely starts with '<' — and fall back to shape when it is absent.
  //
  // Worth noting what that split now says: every human record in the corpus carries an origin, so
  // the shape fallback below no longer admits anything, it only ever filters. It is a backstop for
  // records the current Claude Code has stopped producing, not a live classifier. If a future
  // version drops the field again, it is the thing standing between a mid-turn interjection and
  // silence — so re-measure it rather than deleting it on the strength of today's zero.
  const origin = a.origin;
  const originKind =
    origin && typeof origin === 'object' ? (origin as Record<string, unknown>).kind : undefined;
  if (typeof originKind === 'string') {
    return originKind === 'human' ? { kind: 'user', line, text: a.prompt } : null;
  }
  return HARNESS_QUEUED.test(text) ? null : { kind: 'user', line, text: a.prompt };
}

/**
 * The harness enqueues its OWN blocks through the same queue the user types into —
 * task notifications, system reminders, command plumbing. They are not the human
 * speaking, and letting them through would spend the scarce verbatim-quote slots on
 * machine chatter (a defect this parser's consumers already had to work around).
 * Anchored at the start so a message that merely MENTIONS a tag still counts.
 */
const HARNESS_QUEUED =
  /^<(?:task-notification|system-reminder|local-command|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|tool|output)\b/i;

/** Whitespace-normalised text, the dedupe key for a queued message vs its delivered twin. */
function normText(t: string | undefined): string {
  return (t ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * How far apart a queued record and its delivered twin can sit and still be the same message.
 *
 * A twin is one message recorded twice, so the two records are NEIGHBOURS. A genuine repeat —
 * the user typing "yes" or "continue" again later — is far away. Matching on text alone cannot
 * tell those apart; position can, and it is the only thing that can.
 *
 * This is a BOUND, not a measurement: re-measured 2026-09-01 across 86 transcripts on this machine
 * (was 68), the dedupe drops nothing at any window, so this number changes nothing observable
 * today. It exists to cap the damage if twins reappear in a future Claude Code version.
 */
const TWIN_WINDOW = 40;

/**
 * Fold queued messages into the event stream, dropping only one that is the SAME message already
 * recorded as a real user turn beside it. The delivered record wins: it carries the true position.
 *
 * Text-only matching was the bug. The comment here used to claim a delivered twin was "the common
 * case — ~2/3 of them"; that was false, and it has now failed to reproduce twice. Re-measured
 * 2026-09-01 across 86 transcripts (was 68): of 572 queued_command records, 160 judged human,
 * ZERO were dropped by either dedupe path. So the mechanism still never helps, and the only thing
 * it can still do is delete a message the user genuinely sent twice inside the window — invisible
 * loss under a heading promising every message.
 *
 * Kept anyway, and the reason is the asymmetry rather than the count. If twins return, this stops
 * every repeated message being printed twice as the user's verbatim words; if they do not, it
 * costs nothing, because it fires on nothing. What it must never become is a silent deleter that
 * nobody re-checks — so the number is dated, and the instruction is to re-measure it rather than
 * trust it. Two corpora agreeing is not proof of a third.
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

/**
 * Pull tool_result blocks (the success/error of a prior tool_use) from a record's
 * content. CC shape: a user record carrying
 *   {type:'tool_result', tool_use_id:'toolu_x', is_error:true|false, content:...}
 */
function toolResultEvents(content: unknown[], line: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const failed = b.is_error === true;
      out.push({
        kind: 'tool-result',
        line,
        toolUseId: b.tool_use_id,
        ok: !failed,
        // The failure TEXT, kept only for failures. This is the literal error the agent hit —
        // the raw material for a "what failed / don't repeat" section that is extracted rather
        // than remembered. Successes carry no text: nobody needs to re-read them, and they are
        // the bulk of the bytes.
        ...(failed ? { text: toolResultText(b.content).slice(0, 800) } : {}),
      });
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
 * AskUserQuestion answers ride in as tool_results (CC carries them on user
 * records), so userTurnEvent drops them — yet their text is the human's CONSENT
 * and redirection (users steer via this tool). Surface each as 'user-meta' so IN YOUR
 * WORDS can carry it with its own provenance mark — a bare "Keep them" is a decision with the noun
 * removed, so the block renders the QUESTION beside the answer. NOT 'user': that would move the
 * final-turn boundary. Needs the tool_use_id -> AskUserQuestion map, built as records stream in
 * order (the tool_use always precedes its result). `askIds` is mutated here.
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
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const bb = b as Record<string, unknown>;
    if (bb.type !== 'tool_result' || typeof bb.tool_use_id !== 'string' || !askIds.has(bb.tool_use_id))
      continue;
    const text = toolResultText(bb.content);
    if (text) out.push({ kind: 'user-meta', line, text });
  }
  return out;
}

/**
 * Parse a session log file into a flat event stream.
 * Accepts JSONL (one record per line) and, defensively, a single JSON array.
 * Never throws on a malformed line — bad lines are skipped.
 *
 * `includeSidechain` (default false): normally we DROP subagent (isSidechain) turns so a
 * subagent's work is never mis-attributed to the main agent we're verifying. But when we
 * deliberately read a subagent's OWN transcript (every record there is isSidechain:true),
 * dropping them would empty the parse — so the handoff subagent-digest opts in to keep them.
 */
export function parseSessionLog(logPath: string, opts?: { includeSidechain?: boolean }): ParsedSession {
  const keepSidechain = opts?.includeSidechain === true;
  const raw = readFileSync(logPath, 'utf8');
  const events: SessionEvent[] = [];
  // Mid-turn interjections, held aside so `mergeQueued` can drop the ones that also
  // arrive as ordinary user records rather than double-counting them.
  const queued: SessionEvent[] = [];
  // AskUserQuestion tool_use ids, accumulated in stream order so a later answer
  // (tool_result) can be recognised as user consent. Shared by both parse paths.
  const askIds = new Set<string>();
  const unreadable: number[] = [];

  // NO WHOLE-FILE JSON-ARRAY PATH. There was one, a 24-line duplicate of the dispatch below that
  // every change had to be mirrored into — twice in one day, during the cleanup. Nothing ever fed
  // it: zero array-shaped fixtures have ever been committed, no test builds one, and every caller
  // arrives through `resolveLog` (which globs *.jsonl), an explicit `--log`, or a subagent .jsonl.
  // A hand-made .json array now parses to zero events, and a capture with no user in it is refused
  // outright rather than written — degrading closed, which is the direction this file chooses.
  // JSONL path (real CC transcripts + most fixtures).
  const lines = raw.split('\n');
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const text = rawLine.trim();
    if (!text) return;
    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch {
      // Tolerated, and COUNTED. Every line of a real transcript is JSON, so one that is not is an
      // anomaly worth naming rather than a routine skip.
      unreadable.push(line);
      return;
    }
    if (!keepSidechain && isSidechain(rec)) return; // subagent turn — not the main agent's claim
    const content = assistantContent(rec);
    if (content) events.push(...blocksToEvents(content, line, recordCwd(rec)));
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
