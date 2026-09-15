// Standing rules cross from one handoff to the next in code: the agent can add one or drop one it has a
// reason for, and a rule that silently disappears from its list is put back.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeRules, parseNote, previousRules } from './rules';

describe('parseNote', () => {
  it('splits the summary from the standing rules and the rules the agent dropped', () => {
    const note = parseNote('Where things stand: both fixes in.\n\n## Standing rules\n- Ask before subagents. "ask me first" (L12)\n\n'
      + '## Dropped rules\n- Never push from this clone. Dropped because: the user said it was never theirs (L800)\n\nNext: build the writer.');
    expect(note).toEqual({ summary: 'Where things stand: both fixes in.\n\nNext: build the writer.', rulesGiven: true,
      rules: ['- Ask before subagents. "ask me first" (L12)'], dropped: ['- Never push from this clone. Dropped because: the user said it was never theirs (L800)'] });
  });

  it('treats a note with no rules section as leaving the rules unchanged', () => {
    expect(parseNote('Just a summary.')).toEqual({ summary: 'Just a summary.', rulesGiven: false, rules: [], dropped: [] });
  });
});

describe('mergeRules', () => {
  const previous = ['- Ask before subagents. "ask me first" (2026-09-07T21-32-55:L1885)', '- Never push from this clone. (2026-09-08T14-15-59:L160)'];

  it('keeps the previous rules when the agent gave no list', () => {
    expect(mergeRules(previous, { summary: '', rulesGiven: false, rules: [], dropped: [] })).toEqual({ rules: previous, restored: [], dropped: [] });
  });

  it('drops a rule only when the agent says why, and restores one that silently disappeared', () => {
    const added = '- Use plain words in docs. "keep it clean and human" (L40)';
    const why = '- Never push from this clone. Dropped because: the user said they never said it (L800)';
    expect(mergeRules(previous, { summary: '', rulesGiven: true, rules: [added], dropped: [why] }))
      .toEqual({ rules: [added, previous[0]], restored: [previous[0]], dropped: [why] });
  });
});

describe('previousRules', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  it("reads only the bullets of the handoff's standing rules", () => {
    dir = mkdtempSync(join(tmpdir(), 'delulu-rules-'));
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'handoff.md'), '# x\n\n## Standing rules\n- Keep docs plain. "clean" (a:L3)\nnot a rule\n\n## Repo when saved\n- Branch\n');
    expect(previousRules(dir, 'a')).toEqual(['- Keep docs plain. "clean" (a:L3)']);
  });

  it('has no rules when there is no earlier handoff, or it held none', () => {
    dir = mkdtempSync(join(tmpdir(), 'delulu-rules-'));
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'handoff.md'), '# x\n\n## Repo when saved\n- Branch\n');
    expect(previousRules(dir, undefined)).toEqual([]);
    expect(previousRules(dir, 'a')).toEqual([]);
    expect(previousRules(dir, 'missing')).toEqual([]);
  });
});
