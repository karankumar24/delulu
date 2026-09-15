// Edge cases from real transcripts that change what the next session must be told: how the session
// ended, helpers collected or stopped by hand, where the save command ran, and pasted text.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractSession } from './extract';

type Rec = Record<string, unknown>;
let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });
let n = 0;
const id = () => `edge-${++n}`;
const at = '2026-09-15T10:00:00.000Z';
const write = (recs: Rec[]): string => {
  dir ??= mkdtempSync(join(tmpdir(), 'delulu-edges-'));
  const file = join(dir, `s${++n}.jsonl`);
  writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
};
const user = (content: unknown, extra: Rec = {}): Rec =>
  ({ type: 'user', uuid: id(), timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content }, ...extra });
const reply = (text: string, extra: Rec = {}, model = 'claude-opus-5'): Rec =>
  ({ type: 'assistant', uuid: id(), timestamp: at, message: { role: 'assistant', model, content: [{ type: 'text', text }] }, ...extra });
const call = (toolId: string, name: string, input: Rec): Rec =>
  ({ type: 'assistant', uuid: id(), timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] } });
const result = (toolId: string, text: string, toolUseResult: Rec = {}, isError = false): Rec =>
  ({ type: 'user', uuid: id(), timestamp: at, toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, ...(isError ? { is_error: true } : {}) }] } });
const agent = (toolId: string, description: string, agentId: string): Rec[] => [
  call(toolId, 'Agent', { description, prompt: 'go', subagent_type: 'x', run_in_background: true }),
  result(toolId, `Async agent launched successfully.\nagentId: ${agentId}`, { isAsync: true, status: 'async_launched', agentId }),
];
const LIMIT = "You've hit your session limit · resets 5:10am";

describe('how the session ended', () => {
  it('names a usage limit instead of carrying the app error as the agent speaking', () => {
    const ex = extractSession(write([user('go'), reply('Working on it.'),
      reply(LIMIT, { isApiErrorMessage: true, error: 'rate_limit' }, '<synthetic>')]));
    expect(ex.replies.map((r) => r.text)).toEqual(['Working on it.']);
    expect(ex.ended).toEqual({ kind: 'limit', line: 3, text: LIMIT });
  });

  it('names other app errors, and ignores the filler the app writes after a quit', () => {
    const a = extractSession(write([user('go'), reply('API Error: 529 Overloaded', { isApiErrorMessage: true }, '<synthetic>')]));
    expect(a.ended).toEqual({ kind: 'app-error', line: 2, text: 'API Error: 529 Overloaded' });
    const b = extractSession(write([user('go'), reply('Done.'), reply('No response requested.', {}, '<synthetic>')]));
    expect(b.ended).toBeUndefined();
    expect(b.replies.map((r) => r.text)).toEqual(['Done.']);
  });

  it('names a request the model safeguards blocked', () => {
    const ex = extractSession(write([user('go'), reply('Sure.'), user('now extract it'),
      { type: 'system', subtype: 'model_refusal_no_fallback', timestamp: at, apiRefusalExplanation: 'This request was blocked.' }]));
    expect(ex.ended).toEqual({ kind: 'safeguard', line: 4, text: 'This request was blocked.' });
  });

  it('names an action the session stopped in the middle of, but not the save command itself', () => {
    const a = extractSession(write([user('go'), call('b1', 'Bash', { command: 'npm run build', description: 'Build the app' })]));
    expect(a.ended).toEqual({ kind: 'mid-action', line: 2, text: 'Bash: Build the app' });
    const b = extractSession(write([user('save'), call('b2', 'Bash', { command: 'node "/p/hook/cli.mjs" handoff', description: 'Save' })]));
    expect(b.ended).toBeUndefined();
  });
});

describe('helpers collected or stopped by hand', () => {
  it('reads an agent collected with TaskOutput as finished, with its output as the report', () => {
    const ex = extractSession(write([...agent('t1', 'Accuracy trajectory', 'a1'), call('o1', 'TaskOutput', { task_id: 'a1', block: true }),
      result('o1', '<retrieval_status>success</retrieval_status>\n\n<task_id>a1</task_id>\n\n<status>completed</status>\n\n<output>\nNo metric moved.\n</output>',
        { retrieval_status: 'success', task: { task_id: 'a1', status: 'completed' } })]));
    expect(ex.helpers.map((h) => [h.ended, h.report])).toEqual([['finished', 'No metric moved.']]);
  });

  it('reads a task stopped with TaskStop as stopped by Claude', () => {
    const ex = extractSession(write([...agent('t1', 'Fix review findings', 'a1'), call('s1', 'TaskStop', { task_id: 'a1' }),
      result('s1', 'Successfully stopped task: a1 (Fix review findings)', { message: 'Successfully stopped task: a1 (Fix review findings)', task_id: 'a1' })]));
    expect(ex.helpers.map((h) => [h.ended, h.how])).toEqual([['stopped', 'Stopped by Claude']]);
  });

  it('says a helper never started when its permission prompt closed or auto mode blocked it', () => {
    const ex = extractSession(write([
      call('b1', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }),
      result('b1', 'Tool permission request failed: AbortError: Tool permission stream closed before response received', {}, true),
      call('t2', 'Agent', { description: 'Audit docs', prompt: 'go', subagent_type: 'x' }),
      result('t2', 'claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Agent right now.', {}, true),
    ]));
    expect(ex.helpers.map((h) => [h.what, h.ended])).toEqual([['Start the dev server', 'not started'], ['Audit docs', 'not started']]);
  });
});

describe('the save command and pasted text', () => {
  const save = (words = '') => user(`<command-message>delulu:handoff</command-message>\n<command-name>/delulu:handoff</command-name>${words ? `\n<command-args>${words}</command-args>` : ''}`, { origin: undefined });

  it('marks every line where the handoff command ran, bare or with words', () => {
    const ex = extractSession(write([user('fix the footer'), reply('Fixed.'), save(), user('one more thing'), save('and push next')]));
    expect(ex.saves).toEqual([3, 5]);
  });

  it('keeps a paste apart from the words typed under it, and still carries the message whole', () => {
    const text = '<!-- attach: Terminal | tab:0 -->\n> • Ran git push\n>   └ 9c4c9de\n\nwhy did the push not trigger CI';
    const [said] = extractSession(write([user(text)])).turns;
    expect(said).toMatchObject({ kind: 'said', text, typed: 'why did the push not trigger CI',
      pasted: { source: 'Terminal | tab:0', text: '• Ran git push\n  └ 9c4c9de' } });
  });
});

describe('shapes seen on real sessions', () => {
  it('names a safeguard block the app wrote in the agent\'s place', () => {
    const text = "API Error: Opus 5's safeguards flagged this message. Try rephrasing the request in a new session.";
    const ex = extractSession(write([user('go'), reply(text, { isApiErrorMessage: true, error: 'invalid_request' }, '<synthetic>')]));
    expect(ex.ended).toEqual({ kind: 'safeguard', line: 2, text });
  });

  it('reads a background command stopped with TaskStop whose result is JSON text', () => {
    const json = JSON.stringify({ message: 'Successfully stopped task: bk1 (Rerun the audit)', task_id: 'bk1', task_type: 'local_bash' });
    const ex = extractSession(write([
      call('b1', 'Bash', { command: 'node audit.mjs', description: 'Rerun the audit', run_in_background: true }),
      result('b1', 'Command running in background with ID: bk1.', { backgroundTaskId: 'bk1' }),
      call('s1', 'TaskStop', { task_id: 'bk1' }),
      result('s1', json, { message: 'Successfully stopped task: bk1 (Rerun the audit)', task_id: 'bk1' }),
    ]));
    expect(ex.helpers.map((h) => [h.kind, h.ended, h.how])).toEqual([['command', 'stopped', 'Stopped by Claude']]);
  });
});

describe('what a pick approved, and helpers that never ran', () => {
  it('keeps the preview of the option the user picked', () => {
    const q = { question: 'Which copy?', header: 'Copy', multiSelect: false, options: [
      { label: 'Keep the lead', description: 'As worded now', preview: 'Earned on camera.' }, { label: 'Rewrite', description: 'Shorter' }] };
    const ex = extractSession(write([call('q1', 'AskUserQuestion', { questions: [q] }),
      result('q1', 'User has answered.', { questions: [q], answers: { 'Which copy?': 'Keep the lead' } })]));
    const [asked] = ex.turns;
    expect(asked.kind === 'asked' && asked.questions[0].options[0]).toEqual({ label: 'Keep the lead', description: 'As worded now', preview: 'Earned on camera.' });
  });

  it('reads a foreground agent the user interrupted as stopped, not failed', () => {
    const ex = extractSession(write([call('t1', 'Agent', { description: 'Hunt bugs', prompt: 'go', subagent_type: 'x' }),
      result('t1', '[Request interrupted by user for tool use]', {}, true)]));
    expect(ex.helpers.map((h) => [h.ended, h.how])).toEqual([['stopped', 'Stopped by the user']]);
  });
});

describe('where helpers worked', () => {
  it('names the branch a helper worked on, and the helpers it started itself', () => {
    const log = write([...agent('t1', 'Build the shell', 'a1')]);
    const sub = join(log.replace(/\.jsonl$/, ''), 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ description: 'Build the shell', worktreeBranch: 'worktree-agent-a1', spawnDepth: 1 }));
    writeFileSync(join(sub, 'agent-a9.meta.json'), JSON.stringify({ description: 'Audit fixtures', parentAgentId: 'a1', spawnDepth: 2 }));
    const [h] = extractSession(log).helpers;
    expect([h.branch, h.started]).toEqual(['worktree-agent-a1', ['Audit fixtures']]);
  });
});

describe('things outside the conversation', () => {
  it('carries a message another session sent, labelled as not the user', () => {
    const ex = extractSession(write([user('Another Claude session sent a message:\n<agent-message from="se-builder">Blocked on task 1.</agent-message>',
      { isMeta: true, origin: { kind: 'peer', from: 'se-builder', name: 'se-builder', body: 'Blocked on task 1.' } })]));
    expect(ex.turns).toEqual([{ kind: 'relayed', line: 1, at, from: 'se-builder', text: 'Blocked on task 1.' }]);
  });

  it('lists routines and wake-ups the session scheduled, and the pull requests it linked', () => {
    const raw = JSON.stringify({ action: 'create', body: { name: 'Repo health check', cron_expression: '0 13 * * 1,4' } });
    const pr = { type: 'pr-link', prNumber: 7, prRepository: 'me/app', prUrl: 'https://github.com/me/app/pull/7' };
    const ex = extractSession(write([call('r1', 'RemoteTrigger', { __unparsedToolInput: { raw } }),
      call('w1', 'ScheduleWakeup', { delaySeconds: 300, reason: 'Waiting on CI before merging' }), pr, pr]));
    expect(ex.scheduled).toEqual([{ line: 1, what: 'Repo health check (0 13 * * 1,4)' }, { line: 2, what: 'Wake-up in 300s: Waiting on CI before merging' }]);
    expect(ex.prs).toEqual([{ number: 7, repo: 'me/app', url: 'https://github.com/me/app/pull/7' }]);
  });

  it('carries a workflow run as a helper', () => {
    const ex = extractSession(write([call('f1', 'Workflow', { name: 'deep-research', args: 'q' })]));
    expect(ex.helpers.map((h) => [h.kind, h.what, h.ended])).toEqual([['workflow', 'deep-research', 'running']]);
  });
});

describe('scheduled work and relayed senders, as real sessions record them', () => {
  it('keeps only the wake-up still pending: a later one replaces an earlier one, and a stop clears it', () => {
    const raw = JSON.stringify({ action: 'create', body: { name: 'Repo health check', cron_expression: '0 13 * * 1,4' } });
    const pending = extractSession(write([call('w1', 'ScheduleWakeup', { delaySeconds: 60, reason: 'first' }),
      call('w2', 'ScheduleWakeup', { delaySeconds: 1800, reason: 'fallback heartbeat' })]));
    expect(pending.scheduled).toEqual([{ line: 2, what: 'Wake-up in 1800s: fallback heartbeat' }]);
    const stopped = extractSession(write([call('w1', 'ScheduleWakeup', { delaySeconds: 1800, reason: 'heartbeat' }),
      call('r1', 'RemoteTrigger', { __unparsedToolInput: { raw } }), call('w2', 'ScheduleWakeup', { stop: true })]));
    expect(stopped.scheduled).toEqual([{ line: 2, what: 'Repo health check (0 13 * * 1,4)' }]);
  });

  it('names the other session by its name, not its socket', () => {
    const ex = extractSession(write([user('Another Claude session sent a message: mine the transcripts',
      { isMeta: true, origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/52640.sock', name: 'projectprevious-ee', body: 'mine the transcripts' } })]));
    expect(ex.turns.map((t) => t.kind === 'relayed' && t.from)).toEqual(['projectprevious-ee']);
  });
});

describe('saves started by the agent', () => {
  it('marks a save the agent started with the handoff skill, and the capture command it ran', () => {
    const ex = extractSession(write([user('wrap up and handoff'), call('k1', 'Skill', { skill: 'delulu:handoff' }),
      result('k1', 'Launching skill: delulu:handoff'), call('b1', 'Bash', { command: 'node "/p/hook/cli.mjs" handoff', description: 'Save' })]));
    expect(ex.saves).toEqual([2, 4]);
  });

  it('marks a save run as the handoff script itself, but not a command that only reads it', () => {
    const ex = extractSession(write([user('save'), call('b1', 'Bash', { command: 'node "/p/hook/handoff.mjs"', description: 'Save' })]));
    expect(ex.saves).toEqual([2]);
    // Retrying with the transcript path, as the failure message says to, is still the save.
    expect(extractSession(write([user('save'), call('b3', 'Bash', { command: 'node "/p/hook/handoff.mjs" --log /x/s.jsonl' })])).saves).toEqual([2]);
    expect(extractSession(write([user('look'), call('b2', 'Bash', { command: 'node hook/handoff.mjs --repo /tmp/x' })])).saves).toEqual([]);
  });
});

describe('a session that is saving has not ended', () => {
  const save = () => call('s1', 'Bash', { command: 'node "/p/hook/cli.mjs" handoff', description: 'Save' });

  it('does not call a tool still running beside the save an ending', () => {
    const ex = extractSession(write([user('wrap up'), save(), call('b1', 'Bash', { command: 'npm test', description: 'Run the suite' })]));
    expect(ex.ended).toBeUndefined();
  });

  it('still names a session that died mid-action after an earlier save and more work', () => {
    const ex = extractSession(write([user('save now'), save(), result('s1', 'saved'), user('now build it'),
      call('b2', 'Bash', { command: 'npm run build', description: 'Build the app' })]));
    expect(ex.ended).toEqual({ kind: 'mid-action', line: 5, text: 'Bash: Build the app' });
  });
});
