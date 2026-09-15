// What a handoff reads out of a transcript: every message whole, every question with its options and
// answer, app notices apart from the user, and copied records left out.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractSession } from './extract';

let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (s: number) => `2026-09-14T10:00:${String(s).padStart(2, '0')}.000Z`;

type Rec = Record<string, unknown>;
const typed = (text: string, extra: Rec = {}): Rec =>
  ({ type: 'user', uuid: id(), timestamp: at(1), origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra });
const said = (text: string): Rec =>
  ({ type: 'assistant', uuid: id(), timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const ask = (toolId: string, questions: Rec[], text?: string): Rec =>
  ({ type: 'assistant', uuid: id(), timestamp: at(3), message: { role: 'assistant', content: [
    ...(text ? [{ type: 'text', text }] : []),
    { type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: { questions } },
  ] } });
const answer = (toolId: string, result: Rec, extra: Rec = {}, content = 'User has answered your questions.', isError = false): Rec =>
  ({ type: 'user', uuid: id(), timestamp: at(4), toolUseResult: result, ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, ...(isError ? { is_error: true } : {}) }] } });
const queued = (prompt: string): Rec =>
  ({ type: 'attachment', uuid: id(), timestamp: at(5), attachment: { type: 'queued_command', commandMode: 'prompt', prompt, origin: { kind: 'human' } } });
const command = (name: string, args: string): Rec =>
  ({ type: 'user', uuid: id(), timestamp: at(6), message: { role: 'user',
    content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } });

const Q = { question: 'Which fix first?', header: 'Fix', multiSelect: false, options: [
  { label: 'The prune bug (Recommended)', description: 'Deletes newest handoffs east of UTC.' },
  { label: 'The sort bug', description: 'Loads an older handoff as latest.' },
] };

function write(name: string, recs: Rec[]): string {
  dir ??= mkdtempSync(join(tmpdir(), 'delulu-extract-'));
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('extractSession: your messages', () => {
  it('carries a typed message whole, line breaks and code included, with its line and time', () => {
    const text = 'fix this\n\n```ts\nconst a = 1;\n```\n  and keep the indent';
    const log = write('s', [{ type: 'mode', mode: 'x' }, typed(text)]);
    const { turns } = extractSession(log);
    expect(turns).toEqual([{ kind: 'said', line: 2, at: at(1), text, how: 'typed' }]);
  });

  it('never shortens a long message', () => {
    const text = `${'every word matters here. '.repeat(400)}and this is the last line`;
    const log = write('s', [typed(text)]);
    const [first] = extractSession(log).turns;
    expect(first.kind === 'said' && first.text).toBe(text);
  });

  it('carries the words typed after a slash command, and leaves out a bare one', () => {
    const log = write('s', [command('grillme', 'over all\nopen decisions'), command('delulu:resume', '')]);
    expect(extractSession(log).turns).toEqual([
      { kind: 'said', line: 1, at: at(6), text: '/grillme over all\nopen decisions', how: 'command' },
    ]);
  });

  it('carries a message typed while the agent was working', () => {
    const log = write('s', [said('working'), queued('stop, do the sort bug instead')]);
    expect(extractSession(log).turns).toEqual([
      { kind: 'said', line: 2, at: at(5), text: 'stop, do the sort bug instead', how: 'queued' },
    ]);
  });

  it('keeps the first message even when it only says to read the handoff', () => {
    const log = write('s', [typed('read the handoff and continue')]);
    expect(extractSession(log).turns.map((t) => t.kind === 'said' && t.text)).toEqual(['read the handoff and continue']);
  });

  it('never credits machine records to the user', () => {
    const log = write('s', [
      typed('<task-notification><status>completed</status></task-notification>', { origin: { kind: 'task-notification' } }),
      typed('Continue from where you left off.', { isMeta: true }),
      typed('<system-reminder>be brief</system-reminder>'),
      // The desktop app watching a pull request: no origin, delivered like a typed message.
      // Its body mentions its own opening tag, so counting open and close tags never balances.
      typed('<ci-monitor-event>"Auto-fix pull requests" is watching PR #60.</ci-monitor-event>', { origin: undefined }),
      queued('<ci-monitor-event>"Auto-fix pull requests" was just enabled. It will send you a <ci-monitor-event> when CI fails.</ci-monitor-event>'),
    ]);
    expect(extractSession(log).turns).toEqual([]);
  });
});

describe('extractSession: app notices', () => {
  it('keeps the app\'s own prompts apart from what the user typed', () => {
    const log = write('s', [
      typed('I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.'),
      queued('My computer went to sleep while you were working. Please continue from where you left off.'),
      typed('The app was quit while you were working. Please continue from where you left off.', { origin: undefined }),
    ]);
    const { turns, notices } = extractSession(log);
    expect(turns).toEqual([]);
    expect(notices.map((x) => x.line)).toEqual([1, 2, 3]);
  });

  it('carries "Try again" but marks that it may be the app\'s retry button', () => {
    const log = write('s', [typed('Try again')]);
    expect(extractSession(log).turns).toEqual([{ kind: 'said', line: 1, at: at(1), text: 'Try again', how: 'typed', maybeApp: true }]);
  });
});

describe('extractSession: questions', () => {
  it('carries what the agent said just before, the options, and the pick with its description', () => {
    const log = write('s', [
      typed('go'),
      said('Older text that is not the lead-in.'),
      ask('t1', [Q], 'Both bugs reproduce on the real CLI.'),
      answer('t1', { questions: [Q], answers: { 'Which fix first?': 'The sort bug' } }),
    ]);
    const asked = extractSession(log).turns[1];
    expect(asked).toEqual({
      kind: 'asked', line: 3, at: at(3), before: 'Both bugs reproduce on the real CLI.',
      questions: [{ question: 'Which fix first?', options: Q.options, answer: { outcome: 'answered', items: [{ text: 'The sort bug', picked: true }] } }],
    });
  });

  it('tells a typed answer from a pick, item by item, and keeps the notes the user added', () => {
    const multi = { ...Q, multiSelect: true };
    const log = write('s', [
      ask('t1', [multi]),
      answer('t1', { questions: [multi], answers: { 'Which fix first?': ['The sort bug', 'both, prune first'] },
        annotations: { 'Which fix first?': { notes: 'tests before code', preview: 'agent preview' } } }),
    ]);
    const [asked] = extractSession(log).turns;
    expect(asked.kind === 'asked' && asked.questions[0].answer).toEqual({
      outcome: 'answered', notes: 'tests before code',
      items: [{ text: 'The sort bug', picked: true }, { text: 'both, prune first', picked: false }],
    });
  });

  it('says the app closed, not that the user declined, when the app shut down on an open question', () => {
    const log = write('s', [
      ask('t1', [Q]),
      answer('t1', {}, { interruptedByShutdown: true }, "The user doesn't want to proceed with this tool use.", true),
      typed('[Request interrupted by user for tool use]', { origin: undefined, interruptedByShutdown: true }),
      ask('t2', [Q]),
      answer('t2', {}, {}, "The user doesn't want to proceed with this tool use.", true),
      typed('[Request interrupted by user]', { origin: undefined }),
      ask('t3', [Q]),
    ]);
    const turns = extractSession(log).turns;
    const outcome = (i: number) => { const t = turns[i]; return t.kind === 'asked' ? t.questions[0].answer.outcome : t.kind; };
    expect(turns.map((t) => t.kind)).toEqual(['asked', 'stopped', 'asked', 'stopped', 'asked']);
    expect([outcome(0), outcome(2), outcome(4)]).toEqual(['app-closed', 'declined', 'open']);
    expect(turns[1]).toEqual({ kind: 'stopped', line: 3, at: at(1), appClosed: true });
    expect(turns[3]).toEqual({ kind: 'stopped', line: 6, at: at(1), appClosed: false });
  });

  it('marks a question the user closed without answering', () => {
    const log = write('s', [ask('t1', [Q]), answer('t1', { questions: [Q], answers: {} }, {}, 'The user did not answer the questions.')]);
    const [asked] = extractSession(log).turns;
    expect(asked.kind === 'asked' && asked.questions[0].answer).toEqual({ outcome: 'unanswered' });
  });
});

describe('extractSession: continued sessions', () => {
  it('leaves out the records copied from the session it continues, and names that session', () => {
    const parentOwn = [typed('parent message'), said('parent reply')];
    const parent = write('b8f52ff0-parent', [{ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), content: 'x' }, ...parentOwn]);
    const child = write('25caf7a8-child', [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-15T03:09:51.378Z', content: 'continue' },
      ...parentOwn,
      typed('child message', { timestamp: '2026-09-15T03:10:00.000Z' }),
    ]);
    const ex = extractSession(child, { siblings: [parent, child] });
    expect(ex.copied).toEqual({ from: 'b8f52ff0-parent', fromLine: 2, untilLine: 3, records: 2 });
    expect(ex.turns.map((t) => t.kind === 'said' && t.text)).toEqual(['child message']);
    // The parent is not a copy of its child, although they share records.
    const own = extractSession(parent, { siblings: [parent, child] });
    expect(own.copied).toBeUndefined();
    expect(own.turns.map((t) => t.kind === 'said' && t.text)).toEqual(['parent message']);
  });

  it('names the session it continues, not that session\'s own parent', () => {
    const first = [typed('grandparent message')];
    const second = [typed('parent message')];
    const grand = write('a-grand', [{ type: 'mode', timestamp: '2026-09-01T00:00:00.000Z' }, ...first]);
    const parent = write('b-parent', [{ type: 'mode', timestamp: '2026-09-02T00:00:00.000Z' }, ...first, ...second]);
    const child = write('c-child', [{ type: 'mode', timestamp: '2026-09-03T00:00:00.000Z' }, ...first, ...second, typed('child message')]);
    const ex = extractSession(child, { siblings: [grand, parent, child] });
    expect(ex.copied).toEqual({ from: 'b-parent', fromLine: 2, untilLine: 3, records: 2 });
    expect(ex.turns.map((t) => t.kind === 'said' && t.text)).toEqual(['child message']);
  });
});

describe('extractSession: records it could not place', () => {
  it('names a user record with text that no rule carried or excluded', () => {
    const log = write('s', [
      typed('fine'),
      { type: 'user', uuid: id(), timestamp: at(1), message: { role: 'user', content: [{ type: 'mystery', text: 'x' }] }, origin: { kind: 'human' } },
      { type: 'user', uuid: id(), timestamp: at(1), message: { role: 'user', content: 'a new shape' }, origin: { kind: 'human' }, isCompactSummary: true },
    ]);
    // Line 2 has no text block the parser reads, so it is not a message and not unplaced. Line 3 is
    // a compaction summary, excluded by name. Nothing is unplaced.
    expect(extractSession(log).unplaced).toEqual([]);
    const odd = write('odd', [{ type: 'attachment', uuid: id(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'typed mid-turn', origin: { kind: 'human' } }, isSidechain: false },
      { type: 'user', uuid: id(), message: { role: 'user', content: 'dup' }, origin: { kind: 'human' } },
      { type: 'attachment', uuid: id(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'dup', origin: { kind: 'human' } } }]);
    // The queued twin beside its delivered record is merged away by the parser. That is a placement,
    // not a loss: the same words are carried from line 2.
    expect(extractSession(odd).unplaced).toEqual([]);
  });

  it('counts a record the parser skipped, rather than losing it quietly', () => {
    // Bash mode typed mid-turn on a version that wrote no origin: the parser reads it as harness text.
    const log = write('s', [typed('fine'), { type: 'attachment', uuid: id(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<bash-input>git status</bash-input>' } }]);
    expect(extractSession(log).unplaced).toEqual([2]);
  });
});

// ── Helpers the session sent off: agents and background commands, and how each one ended ──

const launch = (toolId: string, description: string, background = true): Rec =>
  ({ type: 'assistant', uuid: id(), timestamp: at(7), message: { role: 'assistant', content: [
    { type: 'tool_use', id: toolId, name: 'Agent', input: { description, prompt: 'go', subagent_type: 'x', ...(background ? { run_in_background: true } : {}) } },
  ] } });
const launched = (toolId: string, agentId: string): Rec =>
  ({ type: 'user', uuid: id(), timestamp: at(8), toolUseResult: { isAsync: true, status: 'async_launched', agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)` }] } });
const note = (taskId: string, toolId: string, status: string, summary: string, result?: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>${result ? `\n<result>${result}</result>` : ''}\n</task-notification>`;
const notified = (text: string): Rec => typed(text, { origin: { kind: 'task-notification' } });
const notifiedQueued = (text: string): Rec =>
  ({ type: 'attachment', uuid: id(), timestamp: at(9), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: text } });

describe('extractSession: helpers', () => {
  it('carries a finished agent with the app\'s own words for how it ended and its whole report', () => {
    const log = write('s', [launch('t1', 'Audit the parser'), launched('t1', 'a1'),
      notified(note('a1', 't1', 'completed', 'Agent "Audit the parser" finished', 'Found 3 bugs.\n\n1. ...'))]);
    expect(extractSession(log).helpers).toEqual([{ kind: 'agent', line: 1, what: 'Audit the parser', id: 'a1', ended: 'finished',
      how: 'Agent "Audit the parser" finished', report: 'Found 3 bugs.\n\n1. ...' }]);
  });

  it('keeps an unfinished agent\'s last words, the files it changed and where its transcript is', () => {
    const log = write('s', [launch('t1', 'Build the kerb'), launched('t1', 'a1'),
      notifiedQueued(note('a1', 't1', 'failed', 'Agent "Build the kerb" failed: You\'ve hit your session limit'))]);
    const transcript = join(dir!, 's', 'subagents', 'agent-a1.jsonl');
    mkdirSync(join(dir!, 's', 'subagents'), { recursive: true });
    writeFileSync(transcript, [
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/kerb.ts', old_string: 'a', new_string: 'b' } }] } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Halfway through the kerb, the east edge is left.' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(extractSession(log).helpers).toEqual([{ kind: 'agent', line: 1, what: 'Build the kerb', id: 'a1', ended: 'failed',
      how: 'Agent "Build the kerb" failed: You\'ve hit your session limit', transcript,
      lastWords: 'Halfway through the kerb, the east edge is left.', files: ['/repo/kerb.ts'] }]);
  });

  it('takes the latest ending when an agent was resumed, and says when one never reported', () => {
    const log = write('s', [
      launch('t1', 'Hunt bugs'), launched('t1', 'a1'), launch('t2', 'Check docs'), launched('t2', 'a2'),
      notified(note('a1', 't1', 'killed', 'Agent "Hunt bugs" was stopped by user')),
      notified(note('a1', 'toolu_sendmessage', 'completed', 'Agent "Hunt bugs" finished', 'All clear.')),
    ]);
    const helpers = extractSession(log).helpers;
    expect(helpers.map((h) => [h.what, h.ended, h.report])).toEqual([['Hunt bugs', 'finished', 'All clear.'], ['Check docs', 'running', undefined]]);
  });

  it('keeps an agent\'s real report when a short follow-up arrives after it', () => {
    const log = write('s', [launch('t1', 'Hunt regressions'), launched('t1', 'a1'),
      notifiedQueued(note('a1', 't1', 'completed', 'Agent "Hunt regressions" finished', 'The rebuild is not yet a clear net improvement. Four regressions.')),
      notifiedQueued(note('a1', 't1', 'completed', 'Agent "Hunt regressions" finished', 'Nothing in the report changes.'))]);
    const [h] = extractSession(log).helpers;
    expect([h.ended, h.report]).toEqual(['finished', 'The rebuild is not yet a clear net improvement. Four regressions.']);
  });

  it('reads a foreground agent that died of an API error as failed, so its resumed report counts', () => {
    const log = write('s', [launch('t1', 'Fix train overshoot', false),
      answer('t1', { status: 'completed', agentId: 'a7' }, {}, 'Agent terminated early due to an API error: API Error: 529 Overloaded.\n\nagentId: a7'),
      notified(note('a7', 'toolu_resume', 'completed', 'Agent "Fix train overshoot" finished', 'All phases complete and verified.'))]);
    const [h] = extractSession(log).helpers;
    expect([h.ended, h.report]).toEqual(['finished', 'All phases complete and verified.']);
  });

  it('marks agents the app lost track of at a restart, unless they had already finished', () => {
    const log = write('s', [
      launch('t1', 'Research criteria'), launched('t1', 'a1'), launch('t2', 'Inventory strings'), launched('t2', 'a2'),
      notified(note('a1', 't1', 'completed', 'Agent "Research criteria" finished', 'Done.')),
      notified('<task-notification>\n<task-id>a1</task-id>\n<task-id>a2</task-id>\n<status>stopped</status>\n<summary>No completion record was found for 2 background agents from the previous session: "Research criteria" (a1), "Inventory strings" (a2).</summary>\n</task-notification>'),
    ]);
    expect(extractSession(log).helpers.map((h) => [h.what, h.ended])).toEqual([['Research criteria', 'finished'], ['Inventory strings', 'no record']]);
  });

  it('keeps a failure the app already reported when a later restart notice names the same agent', () => {
    const log = write('s', [
      launch('t1', 'Scout the corpus'), launched('t1', 'a1'),
      notified(note('a1', 't1', 'failed', 'Agent "Scout the corpus" failed: Agent stalled')),
      notified('<task-notification>\n<task-id>a1</task-id>\n<status>stopped</status>\n<summary>No completion record was found for a background agent from the previous session: "Scout the corpus" (a1).</summary>\n</task-notification>'),
    ]);
    expect(extractSession(log).helpers.map((h) => [h.ended, h.how])).toEqual([['failed', 'Agent "Scout the corpus" failed: Agent stalled']]);
  });

  it('reads a helper that ran in the foreground from its own result', () => {
    const log = write('s', [launch('t1', 'Security review', false),
      answer('t1', { status: 'completed', agentId: 'a9' }, {}, 'No high findings.')]);
    expect(extractSession(log).helpers).toEqual([{ kind: 'agent', line: 1, what: 'Security review', id: 'a9', ended: 'finished', report: 'No high findings.' }]);
  });

  it('carries background commands and how they exited', () => {
    const log = write('s', [
      { type: 'assistant', uuid: id(), timestamp: at(7), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests', run_in_background: true } }] } },
      answer('b1', { backgroundTaskId: 'bk1' }, {}, 'Command running in background with ID: bk1.'),
      notified(note('bk1', 'b1', 'failed', 'Background command "Run the tests" failed with exit code 1')),
    ]);
    expect(extractSession(log).helpers).toEqual([{ kind: 'command', line: 1, what: 'Run the tests', id: 'bk1', ended: 'failed',
      how: 'Background command "Run the tests" failed with exit code 1' }]);
  });
});

describe('extractSession: refusals, replies and start', () => {
  it('carries a tool the user refused, but not one cut off by the app closing', () => {
    const bash = (toolId: string): Rec => ({ type: 'assistant', uuid: id(), timestamp: at(7), message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'git push --force', description: 'Force push main' } }] } });
    const refusal = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
    const log = write('s', [bash('r1'), answer('r1', {}, {}, refusal, true), bash('r2'), answer('r2', {}, { interruptedByShutdown: true }, refusal, true)]);
    expect(extractSession(log).turns).toEqual([{ kind: 'refused', line: 2, at: at(4), tool: 'Bash', what: 'Force push main' }]);
  });

  it('lists the agent\'s replies with their lines, and when the session\'s own records start', () => {
    const log = write('s', [{ type: 'mode', mode: 'x' }, typed('go', { timestamp: '2026-09-15T08:00:00.000Z' }), said('On it.')]);
    const ex = extractSession(log);
    expect(ex.replies).toEqual([{ line: 3, text: 'On it.' }]);
    expect(ex.startedAt).toBe('2026-09-15T08:00:00.000Z');
  });
});
