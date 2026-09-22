// The handoff file the next agent reads: plain names, reading order, and nothing it does not need.
import { describe, it, expect } from 'vitest';
import { renderHandoff } from './write';
import type { HandoffInput } from './write';
import type { Answer, Extraction, Option } from './extract';

const base = (over: Partial<Extraction> = {}): Extraction =>
  ({ turns: [], notices: [], unplaced: [], unreadable: [], helpers: [], replies: [], saves: [], scheduled: [], prs: [], ...over });
const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({
  project: 'delulu', savedAt: new Date(2026, 8, 15, 0, 22), transcript: '~/.claude/projects/p/abc.jsonl', folder: '2026-09-15T00-22-00',
  ex: base(), repo: { branch: 'main', commit: 'eeff441', uncommitted: 6, commits: [] }, redact: (t) => t, ...over,
});

describe('renderHandoff: layout', () => {
  it('opens with when it was saved and lays the parts out under plain names, in reading order', () => {
    const out = renderHandoff(input({ note: 'Fixing the prune bug. Next: commit.',
      ex: base({ turns: [{ kind: 'said', line: 2, text: 'go', how: 'typed' }], replies: [{ line: 5, text: 'Done.' }],
        helpers: [{ kind: 'agent', line: 3, what: 'Audit', ended: 'finished' }] }) }));
    expect(out.split('\n')[0]).toBe('# delulu handoff · saved Tue Sep 15, 2026');
    expect(out.split('\n').filter((l) => l.startsWith('## '))).toEqual(["## Last agent's summary (not checked, so confirm anything it calls done, committed or pushed with git)",
      '## Repo when saved', '## Last exchange', '## Subagents and background tasks', "## The user's messages, newest first"]);
    expect(out).toContain('Fixing the prune bug. Next: commit.');
  });

  it('says plainly when no summary was written, and leaves out parts with nothing in them', () => {
    const out = renderHandoff(input());
    expect(out).toContain('No summary was written when this was saved.');
    expect(out).not.toContain('## Subagents');
  });
});

describe('renderHandoff: the top lines and the repo', () => {
  it('names how the session ended, what it continues, and records it could not place', () => {
    const out = renderHandoff(input({ ex: base({ ended: { kind: 'limit', line: 90, text: "You've hit your session limit" },
      copied: { from: 'b8f52ff0-x', fromLine: 1, untilLine: 40, records: 40 }, unplaced: [12, 30] }) }));
    expect(out).toContain('Transcript: ~/.claude/projects/p/abc.jsonl\n');
    expect(out).toContain("The session ended on a usage limit: You've hit your session limit");
    expect(out).toContain('This chat was reopened from an earlier one. What came before that one was saved is in its own handoff, not repeated here.');
    expect(out).not.toContain('b8f52ff0');
    expect(out).toContain('delulu could not read 2 entries of the transcript (lines 12, 30); a message may be missing there.');
  });

  it('shows the repo when saved, the commits made this session, and linked pull requests', () => {
    const out = renderHandoff(input({ repo: { branch: 'fix/x', commit: 'abc1234', uncommitted: 0, commits: [{ sha: 'abc1234', subject: 'fix: prune' }] },
      ex: base({ prs: [{ number: 7, repo: 'me/app', url: 'https://github.com/me/app/pull/7' }] }) }));
    expect(out).toContain('Branch `fix/x` at `abc1234`, no uncommitted files');
    expect(out).toContain('- `abc1234` fix: prune');
    expect(out).toContain('Pull request #7 in me/app: https://github.com/me/app/pull/7');
  });
});

describe("renderHandoff: the user's messages", () => {
  const at = new Date(2026, 8, 15, 0, 22).toISOString();

  it('lists what the user said newest first, whole, and how it was sent, with no line numbers or times', () => {
    const out = renderHandoff(input({ ex: base({ turns: [
      { kind: 'said', line: 2, at, text: 'first\n\nwith a second paragraph', how: 'typed' },
      { kind: 'said', line: 9, at, text: 'stop, do the sort bug', how: 'queued' },
      { kind: 'said', line: 12, at, text: 'Try again', how: 'typed', maybeApp: true },
    ] }) }));
    const part = out.slice(out.indexOf("## The user's messages"));
    expect(part).toContain("- Try again (may be the app's retry button)");
    expect(part).toContain('- (sent while the agent worked) stop, do the sort bug');
    expect(part).toContain('- first\n\n  with a second paragraph');
    expect(part.indexOf('Try again')).toBeLessThan(part.indexOf('- first'));
    expect(part).not.toMatch(/\bL\d|12:22/);
  });

  it('shows each answer with its question, the meaning of a short pick, and words the user typed', () => {
    const q = (question: string, options: Option[], answer: Answer) => ({ question, options, answer });
    const out = renderHandoff(input({ ex: base({ turns: [{ kind: 'asked', line: 5, before: '', questions: [
      q('Which fix first?', [{ label: 'Prune', description: 'Deletes newest handoffs east of UTC.' }], { outcome: 'answered', items: [{ text: 'Prune', picked: true }] }),
      q('Ship now?', [{ label: 'Ship after the live test (Recommended)', description: 'Wait.' }], { outcome: 'answered', items: [{ text: 'Ship after the live test (Recommended)', picked: true }] }),
      q('Anything else?', [], { outcome: 'answered', items: [{ text: 'fix the footer too', picked: false }], notes: 'urgent' }),
      q('Merge?', [], { outcome: 'app-closed' }),
    ] }] }) }));
    expect(out).toContain('- Asked "Which fix first?": picked "Prune" (Deletes newest handoffs east of UTC.)');
    expect(out).toContain('- Asked "Ship now?": took the agent\'s recommendation "Ship after the live test"');
    expect(out).toContain('- Asked "Anything else?": wrote: fix the footer too · notes: urgent');
    expect(out).toContain('- Asked "Merge?": the app closed before an answer');
  });

  it('marks stops, app closes, refusals, pastes, images and other sessions, never as the user speaking', () => {
    const out = renderHandoff(input({ folder: 'F', ex: base({ turns: [
      { kind: 'stopped', line: 3, appClosed: false }, { kind: 'stopped', line: 4, appClosed: true },
      { kind: 'refused', line: 6, tool: 'Bash', what: 'Force push main' },
      { kind: 'relayed', line: 7, from: 'projectprevious-ee', text: 'mine the transcripts' },
      { kind: 'said', line: 8, text: '<!-- attach: Terminal -->\n> a\n> b\n\nwhy', how: 'typed', typed: 'why', pasted: { source: 'Terminal', text: 'a\nb' } },
      { kind: 'said', line: 10, text: 'look', how: 'typed', images: [{ mediaType: 'image/png', data: 'x' }] },
    ] }) }));
    expect(out).toContain('- Stopped the agent');
    expect(out).toContain('- The app closed while the agent was working');
    expect(out).toContain('- Turned down Bash: Force push main');
    expect(out).toContain('- Another session ("projectprevious-ee") sent this, not the user: mine the transcripts');
    expect(out).toContain('- pasted 2 lines from Terminal (not copied here; it is at line 8 of the transcript), then wrote: why');
    expect(out).toContain('- look · image: .delulu-handoff/F/images/image-1.png');
  });
});

describe('renderHandoff: last exchange', () => {
  it("carries the agent's last reply before the save, whole, and what the user added when saving", () => {
    const out = renderHandoff(input({ ex: base({ saves: [20],
      replies: [{ line: 10, text: 'Older reply.' }, { line: 18, text: 'Both fixes are in.\n\nNext is the check.' }, { line: 22, text: 'Saved.' }],
      turns: [{ kind: 'said', line: 16, text: 'good', how: 'typed' }, { kind: 'said', line: 20, text: '/delulu:handoff and push next', how: 'command' }] }) }));
    const part = out.slice(out.indexOf('## Last exchange'), out.indexOf("## The user's messages"));
    expect(part).toContain("The agent's last reply:\nBoth fixes are in.\n\nNext is the check.");
    expect(part).toContain('When saving, the user added: and push next');
    expect(part).not.toContain('Saved.');
    expect(out.slice(out.indexOf("## The user's messages"))).not.toContain('/delulu:handoff');
  });
});

describe('renderHandoff: subagents and background tasks', () => {
  it('says how each one ended, with the first real line of a report and a way into the rest', () => {
    const out = renderHandoff(input({ ex: base({ helpers: [
      { kind: 'agent', line: 3, what: 'Audit parser', id: 'a1', ended: 'finished', report: 'Done.\n\n## Findings\nThree bugs, all in the queued path.\nMore.', transcript: '/t/agent-a1.jsonl' },
      { kind: 'agent', line: 4, what: 'Build kerb', ended: 'failed', how: 'Agent "Build kerb" failed: session limit', lastWords: 'Halfway through the kerb.', files: ['/r/a.ts', '/r/b.ts'], branch: 'worktree-agent-a2' },
      { kind: 'command', line: 5, what: 'Run the tests', ended: 'running' },
      { kind: 'agent', line: 6, what: 'Check docs', ended: 'not started', how: 'Tool permission request failed: AbortError' },
    ], scheduled: [{ line: 7, what: 'Repo health check (0 13 * * 1,4)' }] }) }));
    expect(out).toContain('- Subagent "Audit parser": finished. Report starts: "Three bugs, all in the queued path." · full report: /t/agent-a1.jsonl');
    expect(out).toContain('- Subagent "Build kerb": failed (Agent "Build kerb" failed: session limit) · last words: "Halfway through the kerb." · changed: /r/a.ts, /r/b.ts · worked on branch `worktree-agent-a2`');
    expect(out).toContain('- Background command "Run the tests": still running when saved');
    expect(out).toContain('- Subagent "Check docs": never started (Tool permission request failed: AbortError)');
    expect(out).toContain('Still scheduled: Repo health check (0 13 * * 1,4)');
  });

  it('folds retries of the same helper into one line with its final outcome', () => {
    const h = (line: number, ended: 'failed' | 'finished') => ({ kind: 'agent' as const, line, what: 'Test continuity', ended });
    const out = renderHandoff(input({ ex: base({ helpers: [h(3, 'failed'), h(4, 'failed'), h(5, 'finished')] }) }));
    expect(out.split('\n').filter((l) => l.includes('"Test continuity"'))).toEqual(['- Subagent "Test continuity": finished (after 2 failed tries)']);
  });

  it('keeps same-named helpers apart when an earlier one finished or is still running, since that is no retry', () => {
    const h = (line: number, ended: 'finished' | 'running') => ({ kind: 'agent' as const, line, what: 'Audit parser', ended });
    const out = renderHandoff(input({ ex: base({ helpers: [h(3, 'finished'), h(4, 'running')] }) }));
    expect(out.split('\n').filter((l) => l.includes('"Audit parser"'))).toEqual(['- Subagent "Audit parser": finished', '- Subagent "Audit parser": still running when saved']);
  });
});

describe('renderHandoff: fitting one read', () => {
  const words = (n: number) => `${'word '.repeat(n)}end`;

  it("shrinks older picks, report excerpts and a long last reply, and never the user's words", () => {
    const questions = Array.from({ length: 60 }, (_, k) => ({ question: `Question ${k} ${'about the parser '.repeat(8)}?`,
      options: [{ label: 'Keep it (Recommended)', description: 'x' }], answer: { outcome: 'answered' as const, items: [{ text: 'Keep it (Recommended)', picked: true }] } }));
    const typed = words(3000);
    const ex = base({ saves: [900], replies: [{ line: 800, text: words(4000) }],
      turns: [{ kind: 'said', line: 1, text: typed, how: 'typed' }, { kind: 'asked', line: 2, before: '', questions }],
      helpers: [{ kind: 'agent', line: 3, what: 'Audit', ended: 'finished', report: words(200) }] });
    const out = renderHandoff(input({ ex, budgetBytes: 10_000 }));
    expect(out).toContain(typed);
    expect(out).not.toContain('Report starts');
    expect(out).toContain('(the rest is at line 800 of the transcript)');
    expect(out).toMatch(/- Asked "Question 0 about the parser [^"]*…": took the agent's recommendation "Keep it"/);
    expect(out).not.toContain(`Question 0 ${'about the parser '.repeat(8)}?`);
    expect(out).toContain('- Asked "Question 59');
  });

  it('leaves a handoff that already fits exactly as it is', () => {
    const ex = base({ replies: [{ line: 5, text: 'Short reply.' }], helpers: [{ kind: 'agent', line: 3, what: 'Audit', ended: 'finished', report: 'Three bugs found.' }] });
    const out = renderHandoff(input({ ex }));
    expect(out).toContain('Report starts: "Three bugs found."');
    expect(out).toContain('Short reply.');
  });
});

describe('renderHandoff: details found on a real session', () => {
  it('skips a report opener that is only a path', () => {
    const report = "I've completed the comparison. My REPORT.md is at:\n\n`/tmp/x/REPORT.md`\n\nFormat B carried 12 of 13 pairs.";
    const out = renderHandoff(input({ ex: base({ helpers: [{ kind: 'agent', line: 3, what: 'Compare', ended: 'finished', report }] }) }));
    expect(out).toContain('Report starts: "Format B carried 12 of 13 pairs."');
  });

  it('keeps a multi-line typed answer inside its list item', () => {
    const out = renderHandoff(input({ ex: base({ turns: [{ kind: 'asked', line: 5, before: '', questions: [{ question: 'Build it?', options: [],
      answer: { outcome: 'answered', items: [{ text: 'not yet\n\nshow me first', picked: false }] } }] }] }) }));
    expect(out).toContain('- Asked "Build it?": wrote: not yet\n\n  show me first');
  });
});

describe('renderHandoff: which save', () => {
  it("takes the last exchange from before the save began, not the agent's chatter while saving", () => {
    const out = renderHandoff(input({ ex: base({ saves: [30, 36],
      replies: [{ line: 20, text: 'Both fixes are in.' }, { line: 33, text: 'Reading the draft back now.' }],
      turns: [{ kind: 'said', line: 25, text: 'wrap up and handoff', how: 'queued' }] }) }));
    expect(out).toContain("The agent's last reply:\nBoth fixes are in.");
    expect(out).not.toContain('Reading the draft back now.');
  });
});

describe('renderHandoff: text that tools can read', () => {
  it('strips control characters from the note and the messages, keeping tabs and newlines', () => {
    const out = renderHandoff(input({ note: 'a\x00b\x09c\x1b[31md', ex: base({ turns: [{ kind: 'said', line: 2, text: 'x\x07y\x0az', how: 'typed' }] }) }));
    expect(out).toContain('ab\x09c[31md');
    expect(out).toContain('xy\x0a');
    expect(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(out)).toBe(false);
  });
});
