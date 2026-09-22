// The handoff the next agent reads: plain names, the parts it needs before its first move first, and
// depth left on disk behind line numbers and paths. Everything is redacted before it is shortened.
import { fullDate, shortTime } from './dates';
import { HANDOFF_BYTES } from './limits';
import { clipText } from './redact';
import type { Extraction, Helper, Question } from './extract';

export interface HandoffInput {
  project: string;
  savedAt: Date;
  transcript: string;
  folder: string;
  ex: Extraction;
  /** The agent's summary, written when saving. Nothing checks it. */
  note?: string;
  repo: { branch?: string; commit?: string; uncommitted?: number; commits: { sha: string; subject: string }[] };
  redact: (t: string) => string;
  /** Bytes the handoff should fit in. It shrinks in a fixed order to get there. Tests set it low. */
  budgetBytes?: number;
}

const ENDING: Record<NonNullable<Extraction['ended']>['kind'], string> = {
  limit: 'on a usage limit', 'app-error': 'on an app error', safeguard: "on a request the model's safeguards blocked", 'mid-action': 'in the middle of an action',
};

const section = (name: string, body: string) => `## ${name}\n${body}`;

/** Fits one read when it can, shrinking in a fixed order; the user's words are never shortened. */
export function renderHandoff(i: HandoffInput): string {
  const budget = i.budgetBytes ?? HANDOFF_BYTES;
  let out = '';
  for (let level = 0; level <= 3; level++) {
    out = compose(i, level);
    if (Buffer.byteLength(out) <= budget) break;
  }
  return out;
}

/** Level 1: older picks keep their question only in short. 2: report excerpts go. 3: a long last reply is cut. */
function compose(i: HandoffInput, level: number): string {
  const { ex, redact } = i;
  const top = [`# ${i.project} handoff · saved ${fullDate(i.savedAt)}`, `Transcript: ${i.transcript} (L123 means line 123 of it)`];
  if (ex.copied) top.push(`This session continues ${ex.copied.from.slice(0, 8)}; its messages up to that session's save are in that handoff, not repeated here.`);
  if (ex.ended) top.push(`The session ended ${ENDING[ex.ended.kind]} (L${ex.ended.line}): ${redact(ex.ended.text)}`);
  if (ex.unplaced.length) top.push(`delulu could not place ${ex.unplaced.length} records (${ex.unplaced.map((l) => `L${l}`).join(', ')}); a message may be missing near them.`);

  const parts = [top.join('\n'), section("Last agent's summary (not checked)", i.note?.trim() ? redact(i.note.trim()) : 'No summary was written when this was saved.')];
  parts.push(section('Repo when saved', repoPart(i)));
  const last = lastExchange(ex, redact, level);
  if (last) parts.push(section('Last exchange', last));
  const helpers = helperLines(ex, redact, level);
  if (helpers) parts.push(section('Subagents and background tasks', helpers));
  const said = messageLines(ex, redact, i.folder, level);
  if (said) parts.push(section("The user's messages, newest first", said));
  // Control characters (a stray null byte, terminal colour codes) make tools read the file as binary.
  return `${parts.join('\n\n')}\n`.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function repoPart(i: HandoffInput): string {
  const r = i.repo;
  const dirty = r.uncommitted === undefined ? 'uncommitted files unknown' : r.uncommitted === 0 ? 'no uncommitted files'
    : `${r.uncommitted} uncommitted file${r.uncommitted === 1 ? '' : 's'}`;
  const lines = [`Branch \`${r.branch ?? 'unknown'}\` at \`${r.commit ?? 'unknown'}\`, ${dirty}`];
  if (r.commits.length) lines.push('Commits this session:', ...r.commits.map((c) => `- \`${c.sha}\` ${i.redact(c.subject)}`));
  for (const pr of i.ex.prs) lines.push(`Pull request #${pr.number} in ${pr.repo}: ${pr.url}`);
  return lines.join('\n');
}

/** The agent's last reply before the save, whole, and anything the user typed after the save command. */
function lastExchange(ex: Extraction, redact: (t: string) => string, level: number): string {
  // A save can span several records: the command or skill, then the capture call. It begins at the
  // first of them after the user's last message; what the agent says while saving is not the exchange.
  const lastSave = ex.saves.at(-1) ?? Infinity;
  const spoke = Math.max(0, ...ex.turns.filter((t) => t.kind === 'said' && t.line < lastSave && !t.text.startsWith('/delulu:handoff')).map((t) => t.line));
  const save = Math.min(lastSave, ...ex.saves.filter((l) => l > spoke));
  const reply = ex.replies.filter((r) => r.line < save).at(-1);
  const command = ex.turns.find((t) => t.kind === 'said' && t.line === save && t.text.startsWith('/delulu:handoff'));
  const added = command?.kind === 'said' ? command.text.replace(/^\/delulu:handoff\s*/, '') : '';
  const lines: string[] = [];
  if (reply) {
    const text = level >= 3 ? clipText(reply.text, 1500, redact) : redact(reply.text);
    lines.push(`The agent's last reply (L${reply.line}):\n${text}${level >= 3 && text.endsWith('…') ? ` (rest at L${reply.line})` : ''}`);
  }
  if (added) lines.push(`When saving, the user added (L${save}): ${redact(added)}`);
  return lines.join('\n\n');
}

const RECENT_ANSWERS = 20;
const RECOMMENDED = /\s*\(Recommended\)\s*$/i;
const OUTCOME: Record<Exclude<Question['answer']['outcome'], 'answered'>, string> = {
  'app-closed': 'the app closed before an answer', declined: 'declined to answer', unanswered: 'closed without answering',
  open: 'still open when saved', failed: 'no answer was recorded', unread: 'no answer was recorded',
};

/** A pick keeps its option's meaning only when the label is too short to carry it (3 words or fewer). */
function answerText(q: Question, redact: (t: string) => string): string {
  const a = q.answer;
  if (a.outcome !== 'answered') return OUTCOME[a.outcome];
  const items = a.items.map((it) => {
    if (!it.picked) return `wrote: ${redact(it.text)}`;
    const label = it.text.replace(RECOMMENDED, '');
    if (label !== it.text) return `took the agent's recommendation "${redact(label)}"`;
    const desc = q.options.find((o) => o.label === it.text)?.description;
    return `picked "${redact(label)}"${desc && label.split(/\s+/).length <= 3 ? ` (${redact(desc)})` : ''}`;
  });
  return `${items.join('; ')}${a.notes ? ` · notes: ${redact(a.notes)}` : ''}`;
}

export function imageExt(mediaType: string): string {
  const sub = (mediaType.toLowerCase().split('/')[1] ?? '').split('+')[0].replace(/[^a-z0-9]/g, '');
  return sub === 'jpeg' ? 'jpg' : sub || 'img';
}

const KIND: Record<Helper['kind'], string> = { agent: 'subagent', command: 'background command', workflow: 'workflow' };
const STATE: Record<Helper['ended'], string> = {
  finished: 'finished', failed: 'failed', stopped: 'stopped', running: 'still running when saved',
  'no record': 'lost track of when the app restarted', 'not started': 'never started',
};
const FILLER = /^(?:done|finished|completed?|ok)[.!]?$|^I(?:'ve| have) (?:completed|finished)\b|^here(?: is|'s) (?:the|my) (?:report|summary|findings)\b|^[-*_]{3,}$/i;

/** The first line of a report that says something: not a heading, not "Done.", not a divider. */
function firstRealLine(report: string): string {
  for (const raw of report.split('\n')) {
    if (raw.trim().startsWith('#')) continue;
    const line = raw.replace(/^[>*\-\s]+/, '').replace(/\*\*/g, '').trim();
    if (line && !FILLER.test(line) && !/^`?[~/.][^\s`]*`?$/.test(line)) return line;
  }
  return '';
}

/** One line per helper, retries of the same one folded into their final outcome. A same-named helper
 * that finished or is still running is its own line, not a retry: its report or state still matters. */
function helperLines(ex: Extraction, redact: (t: string) => string, level: number): string {
  const clip = (t: string, n: number) => clipText(t, n, redact);
  const groups: Helper[][] = [];
  const latest = new Map<string, Helper[]>();
  for (const h of ex.helpers) {
    const k = `${h.kind}:${h.what}`;
    const prev = latest.get(k);
    const last = prev?.[prev.length - 1];
    if (prev && last && last.ended !== 'finished' && last.ended !== 'running') { prev.push(h); continue; }
    const group = [h];
    groups.push(group);
    latest.set(k, group);
  }
  const out = groups.map((tries) => {
    const h = tries[tries.length - 1];
    const earlier = tries.slice(0, -1);
    let line = `- L${h.line} ${KIND[h.kind]} "${redact(h.what)}": ${STATE[h.ended]}`;
    if (h.how && h.ended !== 'finished' && h.ended !== 'running') line += ` (${clip(h.how, 200)})`;
    if (earlier.length) line += ` (after ${earlier.length} ${earlier.every((e) => e.ended === 'failed') ? 'failed' : 'earlier'} tr${earlier.length === 1 ? 'y' : 'ies'})`;
    const first = h.report ? firstRealLine(h.report) : '';
    if (first && level < 2) line += `. Report starts: "${clip(first, 150)}"`;
    if (h.lastWords) line += ` · last words: "${clip(h.lastWords, 300)}"`;
    if (h.files?.length) line += ` · changed: ${h.files.slice(0, 5).map(redact).join(', ')}${h.files.length > 5 ? ` (+${h.files.length - 5} more)` : ''}`;
    if (h.branch) line += ` · worked on branch \`${h.branch}\``;
    if (h.started?.length) line += ` · started: ${h.started.map(redact).join(', ')}`;
    if (h.transcript) line += ` · ${h.ended === 'finished' ? 'full report' : 'transcript'}: ${h.transcript}`;
    return line;
  });
  for (const s of ex.scheduled) out.push(`Still scheduled: ${redact(s.what)}`);
  return out.join('\n');
}

/** Keeps a multi-line message inside its list item. */
const indent = (text: string) => text.split('\n').map((l, k) => (k === 0 || !l ? l : `  ${l}`)).join('\n');

/** Everything the user did, newest first. Their words are never shortened. */
function messageLines(ex: Extraction, redact: (t: string) => string, folder: string, level: number): string {
  const out: string[] = [];
  let shown = 0;
  for (const t of [...ex.turns].reverse()) {
    const when = shortTime(t.at);
    const head = `- L${t.line}${when ? ` · ${when}` : ''}`;
    if (t.kind === 'said') {
      if (t.text.startsWith('/delulu:handoff')) continue;
      const sent = t.how === 'queued' ? ', sent while the agent worked' : '';
      const body = t.pasted ? `pasted ${t.pasted.text.split('\n').length} lines from ${t.pasted.source} (see the transcript), then wrote: ${t.typed ?? ''}` : t.text;
      const shots = (t.images ?? []).map((im, k) => ` · image: .delulu-handoff/${folder}/images/L${t.line}-${k + 1}.${imageExt(im.mediaType)}`).join('');
      out.push(`${head}${sent}: ${indent(redact(body))}${t.maybeApp ? " (may be the app's retry button)" : ''}${shots}`);
    } else if (t.kind === 'asked') {
      for (const q of [...t.questions].reverse()) {
        // Past the newest answers, a plain pick keeps its question in short: a pick answers only its question.
        const a = q.answer;
        const pick = a.outcome === 'answered' && a.items.length === 1 && a.items[0].picked ? a.items[0].text : '';
        if (level >= 1 && shown++ >= RECENT_ANSWERS && pick) {
          const label = pick.replace(RECOMMENDED, '');
          out.push(`${head} · asked "${clipText(q.question, 90, redact)}": ${label !== pick ? `took the agent's recommendation "${redact(label)}"` : `picked "${redact(label)}"`}`);
        } else out.push(`${head} · asked "${redact(q.question)}": ${indent(answerText(q, redact))}`);
      }
    } else if (t.kind === 'stopped') out.push(`${head} · ${t.appClosed ? 'the app closed while the agent was working' : 'stopped the agent'}`);
    else if (t.kind === 'refused') out.push(`${head} · turned down ${t.tool}: ${redact(t.what)}`);
    else out.push(`${head} · another session (${t.from}) sent this, not the user: ${indent(redact(t.text))}`);
  }
  return out.join('\n');
}
