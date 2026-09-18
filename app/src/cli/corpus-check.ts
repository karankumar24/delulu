// The offline check: runs the handoff's extraction over every real transcript on this machine and
// tests it against what Claude Code itself recorded, independently of how the extraction reads it.
// No model and no usage. `npm run corpus` (or pass a projects folder as the first argument).
//
// The app keeps its own copy of what was typed (`queue-operation` enqueue records) and of the last
// prompt (`last-prompt`). Those are the ground truth here. A failure names the session and line.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APP_NOTICES, extractSession } from './extract';
import type { Extraction, Said } from './extract';
import { obj, str, textOf } from './json';
import type { Rec } from './json';
import { HANDOFF_BYTES } from './limits';
import { renderHandoff } from './write';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const CHECKS = [
  'every typed message carried whole',
  'every answer keeps its question',
  'no app notice credited to you',
  'copied records skipped',
  'last prompt matches',
  'every helper carries how it ended',
  'refusals are the user, not the app',
  'app errors never carried as replies',
  'every save marked',
  'every user record placed',
  'every line readable',
  'everything but your own words fits one read',
] as const;
type Check = (typeof CHECKS)[number];
const tally = new Map<Check, { passed: number; failed: string[] }>(CHECKS.map((c) => [c, { passed: 0, failed: [] }]));
const pass = (c: Check) => { tally.get(c)!.passed++; };
const fail = (c: Check, where: string, detail: string) => { tally.get(c)!.failed.push(`${where}  ${detail}`); };
const clip = (s: string, n = 90) => { const f = flat(s); return f.length > n ? `${f.slice(0, n)}…` : f; };

const NOTICE_LIKE = (s: string) => /while you were working/i.test(s) && /continue from where you left off\.?$/i.test(s.trim());
const BARE_COMMAND = /^\/\S+$/;
const COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/;
// Blocks the app puts through the same queue the user types into. Kept here rather than imported,
// so the check does not share the extraction's own list of what counts as machine text.
const APP_BLOCK = /^<(?:task-notification|system-reminder|create-pr-command|ci-monitor-event|agent-message|cross-session-message)\b/i;

/** `/name words` as delivered or carried, against `/name words` as typed. The app may add a plugin prefix. */
function sameCommand(text: string, typed: RegExpExecArray, exact: boolean): boolean {
  const got = COMMAND.exec(text);
  if (!got) return false;
  const [, name, words = ''] = got;
  const [, wanted, wantedWords = ''] = typed;
  const nameOk = name === wanted || name.endsWith(`:${wanted}`);
  return nameOk && (exact ? words.trim() === wantedWords.trim() : flat(words) === flat(wantedWords));
}

const root = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(homedir(), '.claude', 'projects');
const totals = { sessions: 0, said: 0, asked: 0, questions: 0, notices: 0, continued: 0, maybeApp: 0, noLastPrompt: 0, ms: 0, slowest: 0 };
const outcomes = new Map<string, number>();
const neverSent: string[] = [];
/** Sessions whose own messages push the handoff past one read, so resume prints part and points on. */
const overOneRead: string[] = [];
const endings = new Map<string, number>();

for (const project of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = join(root, project.name);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  // Every uuid in the project and each file's first timestamp, for the copy check. Only these are
  // kept across files, since one project folder can hold a gigabyte of transcripts.
  const starts = new Map<string, string>();
  const holders = new Map<string, string[]>();
  for (const f of files) {
    for (const r of readRecords(f)) {
      if (!starts.has(f) && str(r?.timestamp)) starts.set(f, str(r!.timestamp));
      const u = str(r?.uuid);
      if (u) (holders.get(u) ?? holders.set(u, []).get(u)!).push(f);
    }
  }

  for (const file of files) {
    const sid = file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('/') + 9);
    const recs = readRecords(file);
    const t0 = performance.now();
    let ex: Extraction;
    try { ex = extractSession(file, { siblings: files }); } catch (e) {
      fail('every user record placed', sid, `extraction threw: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const ms = performance.now() - t0;
    totals.sessions++; totals.ms += ms; totals.slowest = Math.max(totals.slowest, ms);
    const said = ex.turns.filter((t): t is Said => t.kind === 'said');
    const asked = ex.turns.filter((t) => t.kind === 'asked');
    totals.said += said.length; totals.asked += asked.length; totals.notices += ex.notices.length;
    totals.maybeApp += said.filter((s) => s.maybeApp).length;
    if (ex.copied) totals.continued++;
    const own = (line: number) => !ex.copied || line < ex.copied.fromLine || line > ex.copied.untilLine;

    // 1. Every enqueued text is carried word for word, or excluded by a named rule.
    //
    // What reached the agent, read from the raw records: a slash command as `/name words`, and
    // whether the record is the app's own (meta, or sent by another session or a coordinator).
    const delivered: { line: number; text: string; app: boolean }[] = [];
    recs.forEach((r, i) => {
      if (!r || r.isSidechain === true) return;
      const att = r.type === 'attachment' ? obj(r.attachment) : undefined;
      const raw = r.type === 'user' ? textOf(obj(r.message)?.content) : att?.type === 'queued_command' ? textOf(att.prompt) : '';
      if (!raw.trim()) return;
      const kind = obj(r.origin ?? att?.origin)?.kind;
      const name = raw.match(/<command-name>\s*([^<\s]+)/)?.[1];
      const words = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '';
      delivered.push({ line: i + 1, text: name ? `${name} ${words}`.trim() : raw.trim(), app: r.isMeta === true || (kind !== undefined && kind !== 'human') });
    });
    const carried = new Set(said.map((s) => s.text));
    const carriedFlat = said.map((s) => flat(s.text));
    const noticeTexts = new Set(ex.notices.map((n) => n.text));
    recs.forEach((r, i) => {
      if (!r || r.type !== 'queue-operation' || r.operation !== 'enqueue' || !own(i + 1)) return;
      const text = textOf(r.content).trim();
      if (!text || BARE_COMMAND.test(text) || APP_BLOCK.test(text)) return;
      const where = `${sid}:${i + 1}`;
      const f = flat(text);
      const command = COMMAND.exec(text);
      const hits = delivered.filter((d) => (command ? sameCommand(d.text, command, false) : flat(d.text).includes(f)));
      // Enqueued and then edited or cancelled: the app never sent it, so there is nothing to carry.
      if (!hits.length) { neverSent.push(`${where}  "${clip(text, 60)}"`); return; }
      // Only ever delivered as the app's own record: a scheduled wake-up, or another session's message.
      if (hits.every((d) => d.app)) return;
      const ok = () => pass('every typed message carried whole');
      const bad = (detail: string) => fail('every typed message carried whole', where, `${detail}: "${clip(text)}"`);
      if (APP_NOTICES.has(text)) return noticeTexts.has(text) ? ok() : bad('app notice neither carried nor set aside');
      if (command) return said.some((s) => s.how === 'command' && sameCommand(s.text, command, true)) ? ok() : bad('command words not carried whole');
      if (carried.has(text)) return ok();
      // Messages queued while the agent worked can be delivered together, as one.
      if (said.some((s) => s.text.includes(text))) return ok();
      if (carriedFlat.some((c) => c.includes(f))) return bad('carried with its spacing changed');
      if (carriedFlat.some((c) => f.startsWith(c))) return bad('carried only in part');
      bad('not carried');
    });

    // 2. Every question the agent asked comes back with its words, its options and its real outcome.
    const askedAt = new Map(asked.map((a) => [a.line, a]));
    const resultFor = new Map<string, Rec>();
    for (const r of recs) {
      const content = obj(r?.message)?.content;
      if (r?.type === 'user' && Array.isArray(content))
        for (const b of content) if (obj(b)?.type === 'tool_result') resultFor.set(str(obj(b)?.tool_use_id), r!);
    }
    recs.forEach((r, i) => {
      if (!r || r.type !== 'assistant' || r.isSidechain === true || !own(i + 1)) return;
      const content = obj(r.message)?.content;
      for (const b of Array.isArray(content) ? content.map(obj) : []) {
        if (b?.type !== 'tool_use' || b.name !== 'AskUserQuestion') continue;
        const where = `${sid}:${i + 1}`;
        const qs = (Array.isArray(obj(b.input)?.questions) ? obj(b.input)!.questions as unknown[] : []).map((q) => obj(q) ?? {});
        const got = askedAt.get(i + 1);
        if (!got) { fail('every answer keeps its question', where, 'question not carried'); continue; }
        const result = resultFor.get(str(b.id));
        const answers = obj(obj(result?.toolUseResult)?.answers);
        let ok = true;
        const bad = (detail: string) => { ok = false; fail('every answer keeps its question', where, detail); };
        if (got.questions.length !== qs.length) bad(`${qs.length} questions asked, ${got.questions.length} carried`);
        for (const key of Object.keys(answers ?? {})) if (!qs.some((q) => str(q.question) === key)) bad(`answer to a question that was not asked: "${clip(key)}"`);
        qs.forEach((q, k) => {
          const c = got.questions[k];
          if (!c) return;
          totals.questions++;
          outcomes.set(c.answer.outcome, (outcomes.get(c.answer.outcome) ?? 0) + 1);
          const labels = (Array.isArray(q.options) ? q.options : []).map((o) => str(obj(o)?.label));
          if (c.question !== str(q.question)) bad('question words changed');
          if (c.options.length !== labels.length || c.options.some((o, j) => o.label !== labels[j] || !('description' in o))) bad('options changed');
          if (result?.interruptedByShutdown === true && c.answer.outcome !== 'app-closed') bad(`app closed, carried as ${c.answer.outcome}`);
          if (c.answer.outcome === 'declined' && result?.interruptedByShutdown === true) bad('app shutdown carried as a decline');
          const raw = answers?.[str(q.question)];
          const expected = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).map((v) => str(v).trim()).filter(Boolean);
          if (expected.length && (c.answer.outcome !== 'answered' || c.answer.items.map((x) => x.text).join('\x00') !== expected.join('\x00'))) bad(`answer changed: "${clip(expected.join(', '))}"`);
          if (c.answer.outcome !== 'answered') return;
          for (const item of c.answer.items) {
            if (/^\[Request interrupted|doesn't want to proceed/i.test(item.text)) bad(`app text carried as an answer: "${clip(item.text)}"`);
            if (item.picked && !labels.includes(item.text)) bad(`marked as a pick but not an option: "${clip(item.text)}"`);
            if (!item.picked && labels.includes(item.text)) bad(`an option carried as typed: "${clip(item.text)}"`);
            // An older multi-select wrote its picks as one string, which would read as typed words.
            if (!item.picked && item.text.split(/,\s*/).length > 1 && item.text.split(/,\s*/).every((p) => labels.includes(p))) bad(`options carried as typed: "${clip(item.text)}"`);
          }
        });
        if (ok) pass('every answer keeps its question');
      }
    });

    // 3. Nothing the app wrote reaches the user's words.
    const leaked = said.filter((s) => APP_NOTICES.has(s.text) || NOTICE_LIKE(s.text) || APP_BLOCK.test(s.text));
    for (const s of leaked) fail('no app notice credited to you', `${sid}:${s.line}`, `"${clip(s.text)}"`);
    if (!leaked.length) pass('no app notice credited to you');

    // 4. No carried turn comes from a record that an earlier-starting transcript already holds.
    const mine = starts.get(file);
    const copiedTurns = ex.turns.filter((t) => {
      const u = str(recs[t.line - 1]?.uuid);
      return (holders.get(u) ?? []).some((f) => f !== file && (starts.get(f) ?? '') < (mine ?? ''));
    });
    if (copiedTurns.length) fail('copied records skipped', `${sid}:${copiedTurns[0].line}`, `${copiedTurns.length} turns copied from an earlier session carried as this one's`);
    else pass('copied records skipped');

    // 5. The app's own record of the last prompt is the last thing carried that was not typed while
    // the agent was working. The app does not update that record for a queued message.
    const lastPrompt = recs.reduce((v, r) => (r?.type === 'last-prompt' && str(r.lastPrompt) ? str(r.lastPrompt) : v), '');
    if (!lastPrompt) totals.noLastPrompt++;
    else {
      const lp = flat(lastPrompt).replace(/…$/, '');
      const sent = [...said.filter((s) => s.how !== 'queued'), ...ex.notices.filter((n) => recs[n.line - 1]?.type !== 'attachment')];
      const last = sent.map((s) => ({ line: s.line, text: s.text })).sort((a, b) => a.line - b.line).pop();
      // A continued session's record can still hold the last prompt of the session it copied.
      const fromCopy = !!ex.copied && delivered.some((d) => !own(d.line) && flat(d.text).startsWith(lp));
      if (BARE_COMMAND.test(lp) || (last && flat(last.text).startsWith(lp)) || fromCopy) pass('last prompt matches');
      else fail('last prompt matches', sid, `app says "${clip(lp, 60)}", last carried is ${last ? `"${clip(last.text, 60)}" (L${last.line})` : 'nothing'}`);
    }

    // 6. Every agent launched comes back with the app's own last word on how it ended, and its report whole.
    for (const h of ex.helpers) endings.set(`${h.kind} ${h.ended}`, (endings.get(`${h.kind} ${h.ended}`) ?? 0) + 1);
    const helperAt = new Map(ex.helpers.map((h) => [h.line, h]));
    const told: { ids: string[]; status: string; result?: string }[] = [];
    const toolNames = new Map<string, string>();
    for (const r of recs) {
      if (!r || r.isSidechain === true) continue;
      const content = obj(r.message)?.content;
      if (r.type === 'assistant' && Array.isArray(content))
        for (const b of content.map(obj)) if (b?.type === 'tool_use') toolNames.set(str(b.id), str(b.name));
      const att = r.type === 'attachment' ? obj(r.attachment) : undefined;
      const t = r.type === 'user' ? textOf(content) : att?.type === 'queued_command' ? textOf(att.prompt) : '';
      if (!t.trimStart().startsWith('<task-notification') || /No completion record/.test(t)) continue;
      const open = t.indexOf('<result>');
      const close = t.lastIndexOf('</result>');
      told.push({
        ids: [...t.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim()),
        status: t.match(/<status>([^<]*)<\/status>/)?.[1] ?? '',
        ...(open !== -1 && close > open ? { result: t.slice(open + 8, close).trim() } : {}),
      });
    }
    const REFUSED = /doesn't want to proceed with this tool use/i;
    recs.forEach((r, i) => {
      if (!r || r.type !== 'assistant' || r.isSidechain === true || !own(i + 1)) return;
      const content = obj(r.message)?.content;
      for (const b of Array.isArray(content) ? content.map(obj) : []) {
        if (b?.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Task')) continue;
        const result = resultFor.get(str(b.id));
        const resultText = textOf((obj(result?.message)?.content as unknown[] | undefined)?.map(obj).find((x) => x?.tool_use_id === b.id)?.content);
        if (REFUSED.test(resultText)) continue;
        const where = `${sid}:${i + 1}`;
        const h = helperAt.get(i + 1);
        if (!h) { fail('every helper carries how it ended', where, `agent "${clip(str(obj(b.input)?.description), 50)}" not carried`); continue; }
        const agentId = str(obj(result?.toolUseResult)?.agentId);
        const last = agentId ? told.filter((n) => n.ids.includes(agentId)).pop() : undefined;
        const expected = last ? ({ completed: 'finished', failed: 'failed', killed: 'stopped', stopped: 'stopped' } as Record<string, string>)[last.status] : undefined;
        // The report is the first result after the agent's latest stop; a later result from an agent
        // that had already finished is a follow-up, not a replacement.
        let report: string | undefined;
        let finished = false;
        for (const n of agentId ? told.filter((x) => x.ids.includes(agentId)) : []) {
          if (n.status === 'completed' && n.result) { if (!(finished && report)) report = n.result; }
          else if (n.status !== 'completed') report = undefined;
          finished = n.status === 'completed';
        }
        if (expected && h.ended !== expected) fail('every helper carries how it ended', where, `the app says ${last!.status}, carried as ${h.ended}`);
        else if (last?.status === 'completed' && report && h.report !== report) fail('every helper carries how it ended', where, 'report not carried whole');
        else pass('every helper carries how it ended');
      }
    });

    // 7. A refusal is the user turning a tool down, never the app closing on it.
    const refusedAt = new Set(ex.turns.filter((t) => t.kind === 'refused').map((t) => t.line));
    recs.forEach((r, i) => {
      if (!r || r.type !== 'user' || r.isSidechain === true || !own(i + 1)) return;
      const content = obj(r.message)?.content;
      for (const b of Array.isArray(content) ? content.map(obj) : []) {
        if (b?.type !== 'tool_result' || b.is_error !== true || !REFUSED.test(textOf(b.content))) continue;
        if (toolNames.get(str(b.tool_use_id)) === 'AskUserQuestion') continue;
        const shutdown = r.interruptedByShutdown === true;
        if (shutdown === refusedAt.has(i + 1)) fail('refusals are the user, not the app', `${sid}:${i + 1}`, shutdown ? 'app shutdown carried as a refusal' : 'refusal not carried');
        else pass('refusals are the user, not the app');
      }
    });

    // 8. The app speaking in the agent's place is never the agent, and a session that ended on it says so.
    const appLines = new Set<number>();
    let lastAgent = 0;
    recs.forEach((r, i) => { if (r?.type === 'assistant' && r.isSidechain !== true && own(i + 1)) { lastAgent = i + 1; if (obj(r.message)?.model === '<synthetic>') appLines.add(i + 1); } });
    const lastRec = lastAgent ? recs[lastAgent - 1] : undefined;
    const lastText = textOf(obj(lastRec?.message)?.content).trim();
    const spokeAfter = recs.slice(lastAgent).some((r) => r?.type === 'user' && r.isSidechain !== true && !(obj(r.message)?.content as unknown[] | undefined)?.some?.((b) => obj(b)?.type === 'tool_result') && textOf(obj(r.message)?.content).trim());
    const endedOnApp = appLines.has(lastAgent) && lastText !== 'No response requested.' && !spokeAfter;
    const appLeaked = ex.replies.filter((x) => appLines.has(x.line));
    if (appLeaked.length) fail('app errors never carried as replies', `${sid}:${appLeaked[0].line}`, `${appLeaked.length} app lines carried as the agent`);
    else if (endedOnApp && !ex.ended) fail('app errors never carried as replies', `${sid}:${lastAgent}`, `ended on "${clip(lastText, 50)}" with no ending named`);
    else pass('app errors never carried as replies');

    // 9. Every /delulu:handoff run is marked where it happened.
    // A save can also be the agent starting the handoff skill, or the capture command it runs.
    const startsSave = (r: Rec) => {
      const content = obj(r.message)?.content;
      return Array.isArray(content) && content.map(obj).some((b) => b?.type === 'tool_use'
        && ((b.name === 'Skill' && str(obj(b.input)?.skill) === 'delulu:handoff') || (b.name === 'Bash' && /cli\.mjs"?\s+handoff\b|\bdelulu\s+handoff\b|\bnode\s+"[^"\n]*\/hook\/handoff\.mjs"(?!\s+-)/.test(str(obj(b.input)?.command)))));
    };
    const saved = recs.flatMap((r, i) => (r && r.isSidechain !== true && own(i + 1)
      && ((r.type === 'user' && textOf(obj(r.message)?.content).includes('<command-name>/delulu:handoff</command-name>')) || (r.type === 'assistant' && startsSave(r))) ? [i + 1] : []));
    if (saved.join() !== ex.saves.join()) fail('every save marked', sid, `ran at ${saved.join(', ') || 'none'}, marked ${ex.saves.join(', ') || 'none'}`);
    else pass('every save marked');

    // 10 and 11. Records the extraction could not place, and lines that are not JSON.
    if (ex.unplaced.length) fail('every user record placed', sid, `lines ${ex.unplaced.slice(0, 8).join(', ')}${ex.unplaced.length > 8 ? ` and ${ex.unplaced.length - 8} more` : ''}`);
    else pass('every user record placed');
    if (ex.unreadable.length) fail('every line readable', sid, `lines ${ex.unreadable.slice(0, 8).join(', ')}`);
    else pass('every line readable');

    // 12. Everything delulu decides to carry fits one read, after shrinking. The user's own messages
    // are never cut to fit, so they are measured apart: when they push a handoff past one read,
    // resume prints as far as it can and names the file and line to read on, dropping the oldest
    // messages first because they sit last. (The agent's summary is not here to add: this session is
    // over, so what is measured is the floor, not the total.)
    const page = renderHandoff({ project: 'p', savedAt: new Date(), transcript: file, folder: sid, ex,
      repo: { branch: 'main', commit: 'abc1234', uncommitted: 0, commits: [] }, redact: (t) => t });
    const head = Buffer.byteLength(page.split("\n## The user's messages")[0]);
    if (head > HANDOFF_BYTES) fail('everything but your own words fits one read', sid, `${head} bytes, ${head - HANDOFF_BYTES} over, after shrinking`);
    else pass('everything but your own words fits one read');
    if (Buffer.byteLength(page) > HANDOFF_BYTES) overOneRead.push(`${sid}  ${Buffer.byteLength(page)} bytes`);
  }
}

function readRecords(file: string): (Rec | undefined)[] {
  return readFileSync(file, 'utf8').split('\n').map((l) => { try { return l.trim() ? obj(JSON.parse(l)) : undefined; } catch { return undefined; } });
}

const out: string[] = [];
out.push(`${totals.sessions} sessions in ${root}`);
out.push(`carried: ${totals.said} messages (${totals.maybeApp} "Try again"), ${totals.asked} question rounds (${totals.questions} questions), ${totals.notices} app notices set aside; ${totals.continued} continued sessions`);
out.push(`answers: ${[...outcomes].map(([k, v]) => `${v} ${k}`).join(', ')}`);
out.push(`helpers: ${[...endings].sort().map(([k, v]) => `${v} ${k}`).join(', ')}`);
out.push(`extraction took ${(totals.ms / 1000).toFixed(1)}s in all, slowest session ${(totals.slowest / 1000).toFixed(2)}s; ${totals.noLastPrompt} sessions have no last-prompt record to check`);
out.push(`enqueued but never sent (edited or cancelled first), so not expected: ${neverSent.length}${neverSent.length ? `, e.g. ${neverSent.slice(0, 3).join('; ')}` : ''}`);
out.push(`your own messages push the handoff past one read in ${overOneRead.length} session(s), where resume prints part and names the file${overOneRead.length ? `: ${overOneRead.slice(0, 3).join('; ')}` : ''}`);
out.push('');
let failed = 0;
for (const [name, { passed, failed: f }] of tally) {
  failed += f.length;
  out.push(`${f.length ? 'FAIL' : 'ok  '}  ${name}: ${passed} passed${f.length ? `, ${f.length} failed` : ''}`);
  const shown = process.argv.includes('--all') ? f.length : 12;
  for (const line of f.slice(0, shown)) out.push(`        ${line}`);
  if (f.length > shown) out.push(`        and ${f.length - shown} more (--all lists every one)`);
}
process.stdout.write(out.join('\n') + '\n');
process.exitCode = failed ? 1 : 0;
