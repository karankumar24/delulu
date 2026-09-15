// delulu: what a handoff carries out of a session transcript.
//
// Everything here is read, never written by a model: the user's messages whole, each question the
// agent asked with its options and how it was answered, the app's own prompts kept apart from the
// user, and the records a continued session copied from the one before it left out. It is checked
// against every real transcript on the machine by `corpus-check.ts`, which is how a change in
// Claude Code's transcript format shows up as a failure instead of a quietly shorter handoff.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { mutatedFiles } from '../transcript/files';
import { parseSessionLog } from '../transcript/tail';
import { obj, str, textOf } from './json';
import type { Rec } from './json';

export interface Said {
  kind: 'said';
  line: number;
  at?: string;
  text: string;
  /** 'command' = the words typed after a slash command, carried as `/name words`. */
  how: 'typed' | 'queued' | 'command';
  /** "Try again" is what the app's retry button sends too, and nothing in the record tells them apart. */
  maybeApp?: true;
  images?: { mediaType: string; data: string }[];
  imagesUnsaved?: number;
  /** A terminal or browser excerpt the user attached, kept apart from what they typed under it. */
  pasted?: { source: string; text: string };
  typed?: string;
}

export interface Option { label: string; description: string; preview?: string }

export type Answer =
  | { outcome: 'answered'; items: { text: string; picked: boolean }[]; notes?: string }
  | { outcome: 'unanswered' | 'app-closed' | 'declined' | 'open' }
  | { outcome: 'failed' | 'unread'; detail: string };

export interface Question { question: string; options: Option[]; answer: Answer }

export interface Asked {
  kind: 'asked';
  line: number;
  at?: string;
  /** The last thing the agent said before asking, whole. Clipping is the writer's job, after redaction. */
  before: string;
  questions: Question[];
}

export interface Stopped { kind: 'stopped'; line: number; at?: string; appClosed: boolean }

/** A tool call the user turned down. It is a boundary they set, so the next session must not retry it blind. */
export interface Refused { kind: 'refused'; line: number; at?: string; tool: string; what: string }

/** A message another Claude session sent into this one. It often passes on the user's request, but it is not the user. */
export interface Relayed { kind: 'relayed'; line: number; at?: string; from: string; text: string }

export type Turn = Said | Asked | Stopped | Refused | Relayed;

/**
 * Something the session sent off to work on its own: an agent, or a command run in the background.
 * Its work lives outside the conversation, so without this line the next session does not know it
 * existed, whether it finished, or what it left half done.
 */
export interface Helper {
  kind: 'agent' | 'command' | 'workflow';
  line: number;
  what: string;
  id?: string;
  /** 'no record' = the app restarted and lost track of it before it reported. */
  ended: 'finished' | 'failed' | 'stopped' | 'running' | 'no record' | 'not started';
  /** How it ended, in the app's own words. */
  how?: string;
  /** A finished agent's report, whole. */
  report?: string;
  transcript?: string;
  /** For one that did not finish: the last thing it said, and the files it had changed. */
  lastWords?: string;
  files?: string[];
  /** The git branch an agent worked on in its own worktree, and the agents it started itself. */
  branch?: string;
  started?: string[];
}

export interface Extraction {
  turns: Turn[];
  /** Prompts the app sends in the user's place after a usage limit, sleep or quit. */
  notices: { line: number; text: string }[];
  /** Set when this session opens with records copied from an earlier transcript. */
  copied?: { from: string; fromLine: number; untilLine: number; records: number };
  /** Lines holding user text that no rule carried or excluded: a sign the transcript format moved. */
  unplaced: number[];
  unreadable: number[];
  helpers: Helper[];
  /** Everything the agent wrote to the user, whole, with its line. */
  replies: { line: number; text: string }[];
  /** The time of this session's first own record, so work committed during it can be found. */
  startedAt?: string;
  /** Set when the session did not end normally: a usage limit, an app error, a blocked request, or mid-action. */
  ended?: { kind: 'limit' | 'app-error' | 'safeguard' | 'mid-action'; line: number; text: string };
  /** Lines where /delulu:handoff ran. */
  saves: number[];
  /** Routines and wake-ups the session scheduled, which keep running after it. */
  scheduled: { line: number; what: string }[];
  prs: { number: number; repo: string; url: string }[];
}

interface Notification { line: number; taskIds: string[]; toolUseId?: string; status?: string; summary: string; result?: string }

function notificationOf(line: number, text: string): Notification | undefined {
  if (!/^\s*<task-notification/i.test(text)) return undefined;
  const one = (tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
  const open = text.indexOf('<result>');
  const close = text.lastIndexOf('</result>');
  return {
    line,
    taskIds: [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim()),
    toolUseId: one('tool-use-id'),
    status: one('status'),
    summary: one('summary') ?? '',
    ...(open !== -1 && close > open ? { result: text.slice(open + '<result>'.length, close).trim() } : {}),
  };
}

const REFUSAL = /doesn't want to proceed with this tool use/i;
const RESTART_NOTICE = /^No completion record was found/i;

/**
 * The app's prompts, word for word. They carry the same provenance as typing (`origin.kind:'human'`
 * and an enqueue record), so the wording is the only thing that separates them. An exact list breaks
 * silently on a rewording, which is why `corpus-check.ts` also fails on anything that reads like one.
 */
export const APP_NOTICES = new Set([
  'I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.',
  'My computer went to sleep while you were working. Please continue from where you left off.',
  'The app was quit while you were working. Please continue from where you left off.',
]);

const INTERRUPT = /^\[Request interrupted by user/;
const COMPACT_SUMMARY = /^\s*This session is being continued from a previous conversation/i;

interface Line { type?: string; uuid?: string; at?: string; shutdown: boolean }
interface Result { isError: boolean; shutdown: boolean; text: string; record: Rec }

export function extractSession(log: string, opts: { siblings?: string[] } = {}): Extraction {
  const lines: (Line | undefined)[] = [];
  const results = new Map<string, Result>();
  const candidates: { line: number; queued?: string }[] = [];
  const notifications: Notification[] = [];
  const flow: { line: number; rec: Rec }[] = [];
  const prs = new Map<number, Extraction['prs'][number]>();
  const relayed: Relayed[] = [];

  readFileSync(log, 'utf8').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    let r: Rec | undefined;
    try { r = obj(JSON.parse(raw)); } catch { return; }
    if (!r) return;
    const line = i + 1;
    const shutdown = r.interruptedByShutdown === true;
    lines[i] = { type: str(r.type) || undefined, uuid: str(r.uuid) || undefined, at: str(r.timestamp) || undefined, shutdown };
    if (r.isSidechain === true) return;
    if (r.type === 'assistant' || r.type === 'user' || (r.type === 'system' && /^model_refusal/.test(str(r.subtype)))) flow.push({ line, rec: r });
    if (r.type === 'pr-link' && typeof r.prNumber === 'number') prs.set(r.prNumber, { number: r.prNumber, repo: str(r.prRepository), url: str(r.prUrl) });
    const peer = r.type === 'user' && obj(r.origin)?.kind === 'peer' ? obj(r.origin) : undefined;
    if (peer) relayed.push({ kind: 'relayed', line, ...(str(r.timestamp) ? { at: str(r.timestamp) } : {}), from: str(peer.name) || str(peer.from), text: str(peer.body) });
    const originKind = obj(r.origin)?.kind;
    const fromHuman = originKind === undefined || originKind === 'human';
    if (r.type === 'user') {
      const content = obj(r.message)?.content;
      const blocks = Array.isArray(content) ? content.map(obj) : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
          results.set(b.tool_use_id, { isError: b.is_error === true, shutdown, text: textOf(b.content), record: r });
      }
      const text = textOf(content);
      const told = notificationOf(line, text);
      if (told) notifications.push(told);
      if (fromHuman && r.isMeta !== true && r.isCompactSummary !== true && text.trim() && !COMPACT_SUMMARY.test(text)
        && !blocks.some((b) => b?.type === 'tool_result')) candidates.push({ line });
    } else if (r.type === 'attachment') {
      const a = obj(r.attachment);
      const text = textOf(a?.prompt).trim();
      const kind = obj(a?.origin)?.kind;
      const told = a?.type === 'queued_command' ? notificationOf(line, text) : undefined;
      if (told) notifications.push(told);
      if (a?.type === 'queued_command' && text && (kind === 'human' || (kind === undefined && !/^<task-notification/i.test(text))))
        candidates.push({ line, queued: text });
    }
  });

  const copied = copiedFrom(log, lines, opts.siblings ?? []);
  const inCopy = (line: number) => !!copied && line >= copied.fromLine && line <= copied.untilLine;
  const atOf = (line: number) => { const a = lines[line - 1]?.at; return a ? { at: a } : {}; };

  const parsed = parseSessionLog(log);
  const turns: Turn[] = [];
  const notices: Extraction['notices'] = [];
  const placed = new Set<number>();
  const placedText = new Set<string>();
  const replies: Extraction['replies'] = [];
  const calls = new Map<string, { name: string; input: Rec; line: number; background: boolean }>();
  let before = '';

  for (const ev of parsed.events) {
    if (inCopy(ev.line)) continue;
    if (ev.kind === 'text') { if (ev.text?.trim()) { before = ev.text.trim(); replies.push({ line: ev.line, text: before }); } continue; }
    if (ev.kind === 'tool' && ev.toolUseId && ev.toolName !== 'AskUserQuestion')
      calls.set(ev.toolUseId, { name: ev.toolName ?? '', input: ev.toolInput ?? {}, line: ev.line, background: ev.toolInput?.run_in_background === true });
    if (ev.kind === 'tool-result' && ev.ok === false && ev.toolUseId) {
      const call = calls.get(ev.toolUseId);
      const res = results.get(ev.toolUseId);
      if (call && res && !res.shutdown && REFUSAL.test(res.text)) {
        const what = str(call.input.description) || str(call.input.command) || str(call.input.file_path) || str(call.input.url);
        turns.push({ kind: 'refused', line: ev.line, ...atOf(ev.line), tool: call.name, what });
      }
      continue;
    }
    if (ev.kind === 'user-meta') { before = ''; continue; }
    if (ev.kind === 'tool' && ev.toolName === 'AskUserQuestion') {
      const qs = Array.isArray(ev.toolInput?.questions) ? ev.toolInput.questions : [];
      const res = ev.toolUseId ? results.get(ev.toolUseId) : undefined;
      turns.push({ kind: 'asked', line: ev.line, ...atOf(ev.line), before, questions: qs.map((q) => question(obj(q) ?? {}, res)) });
      before = '';
      continue;
    }
    if (ev.kind !== 'user') continue;
    before = '';
    placed.add(ev.line);
    const text = (ev.text ?? '').trim();
    placedText.add(text.replace(/\s+/g, ' '));
    const blocks = ev.parts && ev.parts.length > 1 ? ev.parts : [text];
    let words = text;
    let command = false;
    if (blocks.some((b) => KNOWN_WRAPPERS.test(b.trim()))) {
      const kept: string[] = [];
      for (const b of blocks.map((x) => x.trim()).filter(Boolean)) {
        if (!KNOWN_WRAPPERS.test(b)) { kept.push(b); continue; }
        const args = commandArgsProse(b);
        if (args) { command = true; kept.push(args); continue; }
        const inner = unwrapUserProse(b);
        if (inner) kept.push(inner);
      }
      words = kept.join('\n\n');
    }
    const shots = { ...(ev.images?.length ? { images: ev.images } : {}), ...(ev.imagesUnsaved ? { imagesUnsaved: ev.imagesUnsaved } : {}) };
    if (!words && !shots.images && !shots.imagesUnsaved) continue;
    if (INTERRUPT.test(words)) { turns.push({ kind: 'stopped', line: ev.line, ...atOf(ev.line), appClosed: !!lines[ev.line - 1]?.shutdown }); continue; }
    if (APP_NOTICES.has(words)) { notices.push({ line: ev.line, text: words }); continue; }
    const how = command ? 'command' : lines[ev.line - 1]?.type === 'attachment' ? 'queued' : 'typed';
    turns.push({ kind: 'said', line: ev.line, ...atOf(ev.line), text: words, how, ...(words === 'Try again' ? { maybeApp: true as const } : {}), ...shots, ...pasteOf(words) });
  }

  // A queued message the parser merged into its delivered twin is placed, by the twin.
  const unplaced = candidates
    .filter((c) => !inCopy(c.line) && !placed.has(c.line) && !(c.queued && placedText.has(c.queued.replace(/\s+/g, ' '))))
    .map((c) => c.line);

  const helpers = helpersOf(log, calls, results, notifications.filter((n) => !inCopy(n.line)));
  const startedAt = lines.find((l, i) => l?.at && !inCopy(i + 1))?.at;
  const appLines = new Set(flow.filter((f) => obj(f.rec.message)?.model === '<synthetic>').map((f) => f.line));
  let ended = endingOf(flow, inCopy);
  const saves = flow.filter((f) => !inCopy(f.line) && isSave(f.rec)).map((f) => f.line);
  // A tool still running when the session saved is not an ending: the session was alive and saving.
  // It counts only when no save came after the user's last message before it.
  if (ended?.kind === 'mid-action') {
    const at = ended.line;
    const spoke = Math.max(0, ...flow.filter((f) => f.line < at && f.rec.type === 'user' && f.rec.isMeta !== true
      && !(obj(f.rec.message)?.content as unknown[] | undefined)?.some?.((b) => obj(b)?.type === 'tool_result')
      && textOf(obj(f.rec.message)?.content).trim()).map((f) => f.line));
    if (saves.some((l) => l > spoke)) ended = undefined;
  }
  const all = [...turns, ...relayed.filter((t) => !inCopy(t.line))].sort((a, b) => a.line - b.line);
  return { turns: all, notices, ...(copied ? { copied } : {}), unplaced, unreadable: parsed.unreadable, helpers,
    replies: replies.filter((r) => !appLines.has(r.line)), ...(startedAt ? { startedAt } : {}), ...(ended ? { ended } : {}), saves,
    scheduled: scheduledOf(calls), prs: [...prs.values()] };
}

const SAVE_CALL = /cli\.mjs"?\s+handoff\b|\bdelulu\s+handoff\b|\bnode\s+"[^"\n]*\/hook\/handoff\.mjs"(?!\s+--repo\b)/;

/** A save is the /delulu:handoff command, the agent starting the handoff skill, or the capture call itself. */
function isSave(rec: Rec): boolean {
  const content = obj(rec.message)?.content;
  if (rec.type === 'user') return textOf(content).includes('<command-name>/delulu:handoff</command-name>');
  if (rec.type !== 'assistant' || !Array.isArray(content)) return false;
  return content.map(obj).some((b) => b?.type === 'tool_use'
    && ((b.name === 'Skill' && str(obj(b.input)?.skill) === 'delulu:handoff') || (b.name === 'Bash' && SAVE_CALL.test(str(obj(b.input)?.command)))));
}

/**
 * How the session ended, when it was not a normal stop: the last thing that happened was the app
 * speaking in the agent's place (a usage limit or error), a blocked request, or a tool call that never
 * got its result. The app's "No response requested." after a quit is filler, not an ending.
 */
function endingOf(flow: { line: number; rec: Rec }[], inCopy: (line: number) => boolean): Extraction['ended'] {
  let tail: Extraction['ended'];
  const pending = new Set<string>();
  for (const { line, rec } of flow) {
    if (inCopy(line)) continue;
    const msg = obj(rec.message);
    const blocks = Array.isArray(msg?.content) ? msg.content.map(obj) : [];
    if (rec.type === 'system') { tail = { kind: 'safeguard', line, text: str(rec.apiRefusalExplanation) || 'The request was blocked by the model.' }; continue; }
    if (rec.type === 'assistant' && msg?.model === '<synthetic>') {
      const text = textOf(msg.content).trim();
      const kind = rec.error === 'rate_limit' ? 'limit' : /safeguards flagged/i.test(text) ? 'safeguard' : 'app-error';
      if (text !== 'No response requested.') tail = { kind, line, text };
      continue;
    }
    if (rec.type === 'assistant') {
      if (blocks.some((b) => b?.type === 'text' && str(b.text).trim())) tail = undefined;
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue;
        const input = obj(b.input) ?? {};
        if (SAVE_CALL.test(str(input.command))) { tail = undefined; continue; }
        pending.add(str(b.id));
        tail = { kind: 'mid-action', line, text: `${str(b.name)}: ${str(input.description) || str(input.command) || str(input.file_path)}` };
      }
      continue;
    }
    const answered = blocks.some((b) => b?.type === 'tool_result' && pending.has(str(b.tool_use_id)));
    if (answered || textOf(msg?.content).trim()) tail = undefined;
  }
  return tail;
}

/** A message that opens with an attached excerpt: the quoted lines are the paste, the rest is typed. */
function pasteOf(words: string): Pick<Said, 'pasted' | 'typed'> {
  const head = words.match(/^<!-- attach: (.*?) -->\n/);
  if (!head) return {};
  const rest = words.slice(head[0].length).split('\n');
  let i = 0;
  while (i < rest.length && rest[i].startsWith('>')) i++;
  const pasted = rest.slice(0, i).map((l) => l.replace(/^> ?/, '')).join('\n');
  return { pasted: { source: head[1], text: pasted }, typed: rest.slice(i).join('\n').trim() };
}

const ENDED: Record<string, Helper['ended']> = { completed: 'finished', failed: 'failed', killed: 'stopped', stopped: 'stopped' };

/**
 * Every agent and background command, and how it ended.
 *
 * Endings arrive as notifications in two shapes (a user record and a queued attachment), and an
 * agent resumed with a message reports again under a DIFFERENT tool-use id, so they are matched on
 * the task id first. The last ending wins. A restart notice names agents the app lost track of, but
 * some of those had already finished, so it only marks the ones that never reported.
 */
function helpersOf(log: string, calls: Map<string, { name: string; input: Rec; line: number; background: boolean }>, results: Map<string, Result>, told: Notification[]): Helper[] {
  const out: Helper[] = [];
  const metas = metasOf(log);
  for (const [toolId, call] of calls) {
    const agent = call.name === 'Agent' || call.name === 'Task';
    const workflow = call.name === 'Workflow';
    if (!agent && !workflow && !(call.name === 'Bash' && call.background)) continue;
    const res = results.get(toolId);
    if (res && REFUSAL.test(res.text)) continue;
    const result = obj(res?.record.toolUseResult);
    const id = str(result?.agentId) || str(result?.backgroundTaskId)
      || res?.text.match(/agentId: (\w+)/)?.[1] || res?.text.match(/background with ID: (\w+)/)?.[1] || undefined;
    const what = str(call.input.description) || str(call.input.command) || str(call.input.name);
    const helper: Helper = { kind: agent ? 'agent' : workflow ? 'workflow' : 'command', line: call.line, what, ...(id ? { id } : {}), ended: 'running' };
    // A permission prompt that closed, or auto mode unable to judge it: the helper never ran at all.
    if (res?.isError && /^Tool permission request failed|auto mode cannot determine/.test(res.text.trim())) {
      out.push({ ...helper, ended: 'not started', how: res.text.trim().split('\n')[0] });
      continue;
    }
    if (res?.isError && /^\[Request interrupted/.test(res.text.trim())) { out.push({ ...helper, ended: 'stopped', how: 'Stopped by the user' }); continue; }
    const async = call.background || result?.isAsync === true || !!result?.backgroundTaskId;
    if (!async && res) {
      // A foreground agent killed by an API error is not an error result; its text says so.
      const died = /^Agent terminated early/.test(res.text.trim());
      helper.ended = res.isError || died ? 'failed' : 'finished';
      if (died) helper.how = res.text.trim().split('\n')[0];
      else if (!res.isError && res.text.trim()) helper.report = res.text.trim();
    }
    for (const n of told) {
      const mine = (id && n.taskIds.includes(id)) || (!!n.toolUseId && n.toolUseId === toolId);
      if (RESTART_NOTICE.test(n.summary)) {
        if ((mine || n.summary.includes(`"${what}"`)) && helper.ended === 'running') { helper.ended = 'no record'; helper.how = n.summary; }
        continue;
      }
      if (!mine) continue;
      const wasFinished = helper.ended === 'finished';
      helper.ended = ENDED[n.status ?? ''] ?? 'stopped';
      helper.how = n.summary;
      // The first finished result is the report; a later one from an agent that already finished is a
      // follow-up. A result after a stop is a resumed agent's new report.
      if (helper.ended === 'finished' && n.result) { if (!(wasFinished && helper.report)) helper.report = n.result; }
      else delete helper.report;
    }
    // Collected by hand: TaskOutput delivers the report, TaskStop ends it. Only where no notification did.
    for (const [otherId, other] of calls) {
      if (!id || str(other.input.task_id) !== id) continue;
      const got = results.get(otherId);
      if (!got || got.isError) continue;
      if (other.name === 'TaskStop' && /Successfully stopped task/.test(got.text) && helper.ended === 'running') {
        helper.ended = 'stopped'; helper.how = 'Stopped by Claude';
      }
      const output = got.text.match(/<output>([\s\S]*?)<\/output>/)?.[1]?.trim();
      if (other.name === 'TaskOutput' && /<status>completed<\/status>/.test(got.text) && output && helper.ended === 'running') {
        helper.ended = 'finished'; helper.report = output;
      }
    }
    const transcript = agent && id ? join(log.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`) : '';
    if (transcript && existsSync(transcript)) {
      helper.transcript = transcript;
      if (helper.ended !== 'finished') {
        try {
          const own = parseSessionLog(transcript, { includeSidechain: true });
          const words = [...own.events].reverse().find((e) => e.kind === 'text' && e.text?.trim())?.text?.trim();
          if (words) helper.lastWords = words;
          const files = mutatedFiles(own);
          if (files.length) helper.files = files;
        } catch { /* an unreadable transcript still leaves its path */ }
      }
    }
    const meta = id ? metas.get(id) : undefined;
    if (meta && str(meta.worktreeBranch)) helper.branch = str(meta.worktreeBranch);
    const kids = [...metas.values()].filter((m) => id && m.parentAgentId === id).map((m) => str(m.description));
    if (kids.length) helper.started = kids;
    out.push(helper);
  }
  return out;
}

/** Each helper agent's metadata file, by agent id: its worktree branch, and which agent started it. */
function metasOf(log: string): Map<string, Rec> {
  const out = new Map<string, Rec>();
  const dir = join(log.replace(/\.jsonl$/, ''), 'subagents');
  try {
    for (const f of readdirSync(dir)) {
      const id = f.match(/^agent-(.+)\.meta\.json$/)?.[1];
      if (!id) continue;
      try { const m = obj(JSON.parse(readFileSync(join(dir, f), 'utf8'))); if (m) out.set(id, m); } catch { /* skip an unreadable one */ }
    }
  } catch { /* no helpers folder */ }
  return out;
}

/** Routines and wake-ups the session scheduled. They run after it ends, so the next session must know. */
function scheduledOf(calls: Map<string, { name: string; input: Rec; line: number }>): Extraction['scheduled'] {
  const out: Extraction['scheduled'] = [];
  // Only the latest wake-up can still be pending: each one replaces the last, and a stop clears it.
  let wake: Extraction['scheduled'][number] | undefined;
  for (const call of calls.values()) {
    if (call.name === 'ScheduleWakeup') {
      wake = call.input.stop === true || typeof call.input.delaySeconds !== 'number' ? undefined
        : { line: call.line, what: `Wake-up in ${call.input.delaySeconds}s: ${str(call.input.reason)}` };
    }
    if (call.name !== 'RemoteTrigger') continue;
    let input: Rec | undefined = call.input;
    const raw = str(obj(call.input.__unparsedToolInput)?.raw);
    if (raw) { try { input = obj(JSON.parse(raw)); } catch { input = undefined; } }
    const body = obj(input?.body);
    if (input?.action === 'create' && body) out.push({ line: call.line, what: `${str(body.name)} (${str(body.cron_expression)})` });
  }
  return (wake ? [...out, wake] : out).sort((a, b) => a.line - b.line);
}

function question(q: Rec, res: Result | undefined): Question {
  const options = (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: str(obj(o)?.label), description: str(obj(o)?.description), ...(typeof obj(o)?.preview === 'string' ? { preview: str(obj(o)?.preview) } : {}) }));
  const asked = str(q.question);
  return { question: asked, options, answer: answerTo(asked, options, res) };
}

function answerTo(asked: string, options: Option[], res: Result | undefined): Answer {
  if (!res) return { outcome: 'open' };
  if (res.isError) {
    // The app quitting is recorded as a rejection too. The flag is checked first, or a shutdown reads
    // as the user refusing a question they never saw close.
    if (res.shutdown) return { outcome: 'app-closed' };
    if (/doesn't want to proceed|rejected/i.test(res.text)) return { outcome: 'declined' };
    return { outcome: 'failed', detail: res.text };
  }
  const result = obj(res.record.toolUseResult);
  const map = obj(result?.answers);
  if (!map) return { outcome: 'unread', detail: res.text };
  const value = map[asked];
  const labels = new Set(options.map((o) => o.label));
  const items = (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
    .map((v) => str(v).trim()).filter(Boolean)
    .map((text) => ({ text, picked: labels.has(text) }));
  if (!items.length) return { outcome: 'unanswered' };
  const notes = str(obj(obj(result?.annotations)?.[asked])?.notes).trim();
  return { outcome: 'answered', items, ...(notes ? { notes } : {}) };
}

/**
 * The earlier transcript this one continues, when it opens with that transcript's records.
 *
 * A continued session copies its parent's records with their uuids and times, so the uuid is the only
 * trace, and of two files sharing records the copy is the one that started later. The copy begins
 * with the parent's first record, so only the head of each sibling is searched. A parent that was
 * itself continued shares that record too, so the longest shared run wins.
 */
function copiedFrom(log: string, lines: (Line | undefined)[], siblings: string[]): Extraction['copied'] {
  const first = lines.findIndex((l) => l?.uuid);
  const start = lines.find((l) => l?.at)?.at;
  if (first === -1 || !start) return undefined;
  const uuid = lines[first]!.uuid!;
  let best: Extraction['copied'];
  for (const sibling of siblings) {
    if (resolve(sibling) === resolve(log)) continue;
    const head = headOf(sibling);
    if (!head.includes(uuid)) continue;
    const theirStart = firstTimestamp(head);
    if (!theirStart || theirStart >= start) continue;
    let text: string;
    try { text = readFileSync(sibling, 'utf8'); } catch { continue; }
    const ids = new Set([...text.matchAll(/"uuid":"([^"]+)"/g)].map((m) => m[1]));
    let until = first;
    let records = 0;
    for (let i = first; i < lines.length; i++) {
      const u = lines[i]?.uuid;
      if (!u) continue;
      if (!ids.has(u)) break;
      until = i;
      records++;
    }
    if (!best || records > best.records)
      best = { from: basename(sibling).replace(/\.jsonl$/, ''), fromLine: first + 1, untilLine: until + 1, records };
  }
  return best;
}

const HEAD_BYTES = 256 * 1024;

function headOf(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

function firstTimestamp(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    if (!raw.includes('"timestamp"')) continue;
    try { const t = obj(JSON.parse(raw))?.timestamp; if (typeof t === 'string') return t; } catch { /* next line */ }
  }
  return undefined;
}

/**
 * Harness wrappers that open a user record, listed by name. An unknown tag means keep: a leaked tag
 * is visible, a deleted message is not.
 */
const KNOWN_WRAPPERS = /^\s*<(task-notification|command-message|command-name|command-args|local-command-stdout|local-command-stderr|create-pr-command|ci-monitor-event|system-reminder|preview-annotation-context|observed_from_primary_session|tool_use_error|tool_result|output)\b/i;

/**
 * The user's own prose from a wrapped record, or '' when it is only machine text. Strips every leading
 * wrapper and keeps what follows, unless that is the observer plugin's instructions.
 */
function unwrapUserProse(t: string): string {
  let rest = t;
  for (;;) {
    if (!KNOWN_WRAPPERS.test(rest)) break;
    const open = rest.match(/^\s*<([a-z0-9_-]+)([^>]*)>/i);
    if (!open) break;
    // `<tag/>` has no body and no close tag.
    if (open[2].trimEnd().endsWith('/')) { rest = rest.slice(open[0].length); continue; }
    let end = closingIndex(rest, open[1], open[0].length);
    // A body that mentions its own opening tag never balances, so the last close tag ends it.
    if (end === -1) {
      const close = `</${open[1].toLowerCase()}>`;
      const last = rest.toLowerCase().lastIndexOf(close);
      if (last !== -1) end = last + close.length;
    }
    // An unclosed wrapper may be the user typing a tag in a sentence, so the rest is kept.
    if (end === -1) break;
    rest = rest.slice(end);
  }
  rest = rest.trim();
  if (!rest) return '';
  // Only a closed observer tag disqualifies the rest: that is the plugin emitting a block, while a bare
  // mention is a person writing about one.
  if (/^<\/?observ(?:ation|ed_from)/i.test(rest) || /<\/observ(?:ation|ed_from\w*)\s*>/i.test(rest)) return '';
  return rest;
}

/** Index just past the `</tag>` that closes the tag opened at `from`, counting nested ones, or -1. */
function closingIndex(s: string, tag: string, from: number): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1]) { if (--depth === 0) return m.index + m[0].length; }
    else if (!m[0].trimEnd().endsWith('/>')) depth++;
  }
  return -1;
}

/** The words typed after a slash command, as `/name words`, or '' for a bare command. */
function commandArgsProse(t: string): string {
  const m = t.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  const body = (m?.[1] ?? '').trim();
  if (!body) return '';
  const name = t.match(/<command-name>\s*([^<\s]+)/i)?.[1] ?? '';
  return name ? `${name} ${body}` : body;
}
