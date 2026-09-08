// delulu engine — session tail unit tests.
// Proves we parse real CC JSONL shape AND tolerate garbage lines / unknown schema.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionLog } from './tail';

function tmpLog(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'delulu-tail-'));
  const p = join(d, name);
  writeFileSync(p, content);
  return p;
}

describe('parseSessionLog', () => {
  it('parses real-CC-shaped assistant text + tool_use', () => {
    const log = tmpLog(
      'real.jsonl',
      [
        '{"type":"summary","sessionId":"abc123"}',
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'Done, committed.' },
              { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.ts' } },
            ],
          },
        }),
      ].join('\n'),
    );
    const parsed = parseSessionLog(log);
    const text = parsed.events.find((e) => e.kind === 'text');
    const tool = parsed.events.find((e) => e.kind === 'tool');
    expect(text?.text).toBe('Done, committed.');
    expect(tool?.toolName).toBe('Write');
    expect(tool?.toolInput?.file_path).toBe('a.ts');
    rmSync(join(log, '..'), { recursive: true, force: true });
  });

  it('tolerates a malformed (non-JSON) line without throwing', () => {
    const log = tmpLog(
      'bad.jsonl',
      [
        'this is not json',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok done"}]}}',
        '{ broken',
      ].join('\n'),
    );
    const parsed = parseSessionLog(log);
    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0].text).toBe('ok done');
  });

  it('tolerates an unknown record schema (no crash, just skipped)', () => {
    const log = tmpLog(
      'weird.jsonl',
      [
        '{"some":"future-field","nested":{"x":1}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
      ].join('\n'),
    );
    const parsed = parseSessionLog(log);
    expect(parsed.events.map((e) => e.text)).toEqual(['hi']);
  });

  it('excludes isSidechain (subagent) turns so their claims are not attributed to the main agent', () => {
    const log = tmpLog(
      'sidechain.jsonl',
      [
        '{"type":"summary","sessionId":"s1"}',
        // a subagent turn — must be dropped entirely (text + tool_use + tool_result)
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'subagent says done' },
              { type: 'tool_use', id: 'sub1', name: 'Write', input: { file_path: 'sub.ts' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub1', is_error: false }] },
        }),
        // the MAIN agent turn — must survive
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'main agent done' },
              { type: 'tool_use', id: 'main1', name: 'Edit', input: { file_path: 'main.ts' } },
            ],
          },
        }),
      ].join('\n'),
    );
    const parsed = parseSessionLog(log);
    expect(parsed.events.map((e) => e.text).filter(Boolean)).toEqual(['main agent done']);
    expect(parsed.events.filter((e) => e.kind === 'tool').map((e) => e.toolInput?.file_path)).toEqual(['main.ts']);
    expect(parsed.events.find((e) => e.toolUseId === 'sub1')).toBeUndefined();
  });
});

describe('parseSessionLog — user turn text capture (the IN YOUR WORDS spine)', () => {
  it('captures the typed text of a real user turn', () => {
    const log = tmpLog(
      'usertext.jsonl',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'fix the login bug please' }] },
      }) + '\n',
    );
    const s = parseSessionLog(log);
    const u = s.events.find((e) => e.kind === 'user');
    expect(u).toBeDefined();
    expect(u!.text).toBe('fix the login bug please');
  });

  it('captures string-content user turns; tool_result carriers still produce no user event', () => {
    const log = tmpLog(
      'usertext2.jsonl',
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'push it to main' } }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', is_error: false }] },
        }),
      ].join('\n') + '\n',
    );
    const s = parseSessionLog(log);
    const users = s.events.filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toBe('push it to main');
  });

  // The reader returned on the FIRST non-empty text block, so a record built from several blocks
  // lost every one after it, with nothing anywhere saying so. One record is one message: the
  // blocks are parts the user sent together.
  it('keeps EVERY text block of a multi-block user record, in order, as one message', () => {
    const log = tmpLog(
      'multiblock.jsonl',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'refactor the parser' },
            { type: 'text', text: 'and do not touch the bundles' },
          ],
        },
      }) + '\n',
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toContain('refactor the parser');
    expect(users[0].text).toContain('and do not touch the bundles');
    expect(users[0].text!.indexOf('refactor')).toBeLessThan(users[0].text!.indexOf('do not touch'));
  });

  // The lethal ordering: the harness block wins the single slot and the typed message is thrown
  // away — then reported to the user as machine plumbing. The engine hands over BOTH; deciding
  // which part is the harness's belongs to the one unwrapper in handoff.ts, not to a second copy
  // of that list down here.
  it('does not let a leading harness block swallow the message beside it', () => {
    const log = tmpLog(
      'harnessfirst.jsonl',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>a background task finished</system-reminder>' },
            { type: 'text', text: 'never deploy on friday' },
          ],
        },
      }) + '\n',
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toContain('never deploy on friday');
  });

  // Same early return, string-block branch: a content array of bare strings kept only the first.
  it('keeps every bare-string content block, not just the first', () => {
    const log = tmpLog(
      'stringblocks.jsonl',
      JSON.stringify({ type: 'user', message: { role: 'user', content: ['first half', 'second half'] } }) + '\n',
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toContain('first half');
    expect(users[0].text).toContain('second half');
  });

  // An attached screenshot is a content block too, and it SPLITS the text around it: the words
  // after the image were the ones being lost. The image block itself must contribute nothing —
  // walking every block makes it easy to start rendering base64 as speech.
  it('keeps the text on BOTH sides of an image block, and none of the image', () => {
    const log = tmpLog(
      'imageblock.jsonl',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo' } },
            { type: 'text', text: 'the footer is misaligned' },
          ],
        },
      }) + '\n',
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toContain('look at this');
    expect(users[0].text).toContain('the footer is misaligned');
    expect(users[0].text).not.toContain('iVBORw0KGgo');
    expect(users[0].text).not.toContain('image/png');
  });
});

// --- Mid-turn interjections (queued_command attachments) ------------------------
// Regression cover for the highest-severity gap found in the 2026-08 handoff audit:
// a message the user types WHILE the agent is working is recorded as an `attachment`
// of type 'queued_command', never as a `type:'user'` record. Measured on the real
// corpus, 111 of 324 such messages (34%) existed in NO user record — so every
// consumer of this parser silently lost a third of the user's steering.
describe('parseSessionLog — queued (mid-turn) user messages', () => {
  const queued = (prompt: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'attachment',
      isSidechain: false,
      timestamp: '2026-08-12T10:00:00.000Z',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt, timestamp: 1 },
      ...extra,
    });
  const userTurn = (text: string) =>
    JSON.stringify({
      type: 'user',
      isSidechain: false,
      timestamp: '2026-08-12T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });

  it('recovers a mid-turn message that never appears as a user record', () => {
    const log = tmpLog('queued.jsonl', [queued('stop, do X instead')].join('\n'));
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual(['stop, do X instead']);
  });

  it('does NOT double-count a queued message that was also delivered as a user turn', () => {
    const log = tmpLog(
      'dupe.jsonl',
      [queued('run the tests first'), userTurn('run the tests first')].join('\n'),
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users).toHaveLength(1);
  });

  it('dedupes across whitespace differences, keeping the delivered record', () => {
    const log = tmpLog(
      'ws.jsonl',
      [queued('  fix   the\nbug '), userTurn('fix the bug')].join('\n'),
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual(['fix the bug']);
  });

  it('keeps events ordered by line after folding queued messages in', () => {
    const log = tmpLog(
      'order.jsonl',
      [userTurn('first'), queued('second — typed mid-turn'), userTurn('third')].join('\n'),
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual(['first', 'second — typed mid-turn', 'third']);
  });

  it('ignores attachments that are not queued commands, and empty prompts', () => {
    const log = tmpLog(
      'other.jsonl',
      [
        JSON.stringify({ type: 'attachment', attachment: { type: 'task_reminder', content: [] } }),
        JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: 'x' } }),
        queued('   '),
      ].join('\n'),
    );
    expect(parseSessionLog(log).events.filter((e) => e.kind === 'user')).toHaveLength(0);
  });

  it('drops a subagent-sidechain queued message unless sidechain is opted in', () => {
    const log = tmpLog('side.jsonl', [queued('sub message', { isSidechain: true })].join('\n'));
    expect(parseSessionLog(log).events.filter((e) => e.kind === 'user')).toHaveLength(0);
    expect(
      parseSessionLog(log, { includeSidechain: true }).events.filter((e) => e.kind === 'user'),
    ).toHaveLength(1);
  });
});

describe('parseSessionLog — queued harness blocks are not the user', () => {
  it('ignores task notifications and other harness blocks arriving through the queue', () => {
    const q = (prompt: string) =>
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt } });
    const log = tmpLog(
      'harness.jsonl',
      [
        q('<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
        q('<system-reminder>do a thing</system-reminder>'),
        q('<bash-input>ls</bash-input>'),
        q('actually hold on, revert that'),
      ].join('\n'),
    );
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual(['actually hold on, revert that']);
  });

  it('still keeps a real message that merely mentions a harness tag', () => {
    const log = tmpLog(
      'mentions.jsonl',
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: 'why did the <task-notification> block show up twice?',
        },
      }),
    );
    expect(parseSessionLog(log).events.filter((e) => e.kind === 'user')).toHaveLength(1);
  });
});

describe('parseSessionLog — queued-message provenance', () => {
  const q = (prompt: string, origin?: unknown) =>
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt, ...(origin ? { origin } : {}) },
    });

  it('trusts origin.kind=human even when the message starts with a tag-like character', () => {
    const log = tmpLog('human.jsonl', q('<div> is not rendering, fix it', { kind: 'human' }));
    const users = parseSessionLog(log).events.filter((e) => e.kind === 'user');
    expect(users.map((u) => u.text)).toEqual(['<div> is not rendering, fix it']);
  });

  it('rejects a queued record whose origin is explicitly not human', () => {
    const log = tmpLog('bot.jsonl', q('run the deploy', { kind: 'system' }));
    expect(parseSessionLog(log).events.filter((e) => e.kind === 'user')).toHaveLength(0);
  });
});

// Why the dedupe keys on position and not on text alone is documented at `mergeQueued` in tail.ts,
// with the measurement. These pin the behaviour: a twin is adjacent, a genuine repeat is not.
describe('queued messages — a twin is adjacent, a repeat is not', () => {
  const queued = (text: string) =>
    `{"type":"attachment","attachment":{"type":"queued_command","prompt":${JSON.stringify(text)},"origin":{"kind":"human"}}}`;
  const user = (text: string) =>
    `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
  const filler = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}';
  const userTexts = (log: string) =>
    parseSessionLog(log).events.filter((e) => e.kind === 'user').map((e) => e.text);

  it('still drops a queued message delivered as a user record right beside it', () => {
    const p = tmpLog('twin.jsonl', [queued('stop and use the regex version'), user('stop and use the regex version')].join('\n'));
    expect(userTexts(p).filter((t) => t === 'stop and use the regex version')).toHaveLength(1);
  });

  it('KEEPS the same words sent again much later — a repeat is not a duplicate', () => {
    const rows = [user('continue')];
    for (let i = 0; i < 60; i++) rows.push(filler);
    rows.push(queued('continue'));
    const p = tmpLog('repeat.jsonl', rows.join('\n'));
    expect(userTexts(p).filter((t) => t === 'continue')).toHaveLength(2);
  });

  it('keeps a queued message that never materialised as a user record at all', () => {
    const p = tmpLog('orphan.jsonl', [user('start the refactor'), filler, queued('actually stop, do the parser first')].join('\n'));
    expect(userTexts(p)).toContain('actually stop, do the parser first');
  });
});
