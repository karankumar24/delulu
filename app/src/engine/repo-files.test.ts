// "Files touched via Write/Edit" — the line that was EMPTY in every Windows handoff.
//
// This logic had no test of its own because it lived inside `buildState`, and the only repo an
// integration test can capture from is the machine it runs on. Moved out, it can be asked the
// question directly: given a `C:\repo` root and `C:\repo\src\a.ts`, what does the payload print?
//
// PROVEN here: the mapping from (roots, absolute paths) to the relative names printed in the block.
// NOT PROVEN by this or any other test: that a Windows machine hands those strings to this function
// in the first place. See the header of `path-shape.test.ts`.

import { describe, it, expect } from 'vitest';
import { namesSameRepoFile, repoRelativeFiles } from './repo-files';

describe('repoRelativeFiles — POSIX (the behaviour that has users today)', () => {
  it('keeps repo files, relative and in first-touch order, and drops everything outside', () => {
    expect(repoRelativeFiles(['/repo'], [
      '/repo/src/a.ts',
      '/Users/me/.claude/CLAUDE.md',
      '/repo/b.ts',
      '/repo/src/a.ts',
    ])).toEqual(['src/a.ts', 'b.ts']);
  });

  it('matches the /private spelling macOS realpaths /tmp into', () => {
    expect(repoRelativeFiles(['/private/tmp/x', '/tmp/x'], ['/tmp/x/a.ts'])).toEqual(['a.ts']);
  });

  it('collapses a subagent worktree onto the file it is a copy of', () => {
    expect(repoRelativeFiles(['/repo'], [
      '/repo/.claude/worktrees/agent-1/app/src/x.ts',
      '/repo/app/src/x.ts',
    ])).toEqual(['app/src/x.ts']);
  });

  it('never reports delulu\u2019s own handoff folder as the user\u2019s work', () => {
    // A real file rides along on purpose. Asserting `[]` against the handoff path ALONE passes just
    // as well when the function has stopped matching the repo at all, which is the bug this whole
    // branch is about — the assertion has to be able to tell "filtered" from "found nothing".
    expect(repoRelativeFiles(['/repo'], [
      '/repo/.delulu-handoff/2026-01-01/payload.md',
      '/repo/src/a.ts',
    ])).toEqual(['src/a.ts']);
  });

  it('keeps a Linux filename that legitimately contains a backslash', () => {
    expect(repoRelativeFiles(['/repo'], ['/repo/src/back\\slash.ts'])).toEqual(['src/back\\slash.ts']);
  });
});

describe('repoRelativeFiles — Windows shapes', () => {
  it('names the files under a C:\\ root instead of returning nothing at all', () => {
    // The whole finding: `f.startsWith(pre + '/')` matched no path here, so the block printed
    // `tree **7 uncommitted entries**` and then listed not one of them.
    expect(repoRelativeFiles(['C:\\repo'], [
      'C:\\repo\\src\\a.ts',
      'C:\\Users\\me\\.claude\\CLAUDE.md',
      'C:\\repo\\b.ts',
    ])).toEqual(['src/a.ts', 'b.ts']);
  });

  it('prints repo-relative names with forward slashes, as git and the diff below it do', () => {
    expect(repoRelativeFiles(['C:\\repo'], ['C:\\repo\\app\\src\\deep\\a.ts'])).toEqual(['app/src/deep/a.ts']);
  });

  it('matches when git spells the root C:/repo and the transcript spells it C:\\repo', () => {
    expect(repoRelativeFiles(['C:/repo'], ['C:\\repo\\src\\a.ts'])).toEqual(['src/a.ts']);
  });

  it('counts one file once when the transcript spelled it two ways', () => {
    expect(repoRelativeFiles(['C:\\repo'], [
      'C:\\repo\\src\\a.ts',
      'C:/repo/src/a.ts',
      '\\\\?\\C:\\repo\\src\\a.ts',
    ])).toEqual(['src/a.ts']);
  });

  it('collapses a Windows subagent worktree, which the /-anchored pattern missed', () => {
    expect(repoRelativeFiles(['C:\\repo'], [
      'C:\\repo\\.claude\\worktrees\\agent-1\\app\\src\\x.ts',
    ])).toEqual(['app/src/x.ts']);
  });

  it('does not report the handoff folder on a backslash path either', () => {
    // Same rider, and it caught something: with the OLD code this test passed while asserting `[]`,
    // because the old prefix test matched no Windows path at all and filtered the whole list. A
    // green that means "the function is broken in the way we are fixing" is worse than no test.
    expect(repoRelativeFiles(['C:\\repo'], [
      'C:\\repo\\.delulu-handoff\\2026-01-01\\payload.md',
      'C:\\repo\\src\\a.ts',
    ])).toEqual(['src/a.ts']);
  });

  it('works on a UNC share, where there is no drive letter to key on', () => {
    expect(repoRelativeFiles(['\\\\server\\share\\proj'], [
      '\\\\server\\share\\proj\\src\\a.ts',
      '\\\\server\\other\\proj\\src\\b.ts',
    ])).toEqual(['src/a.ts']);
  });

  it('does not claim a sibling directory or another drive is inside the repo', () => {
    expect(repoRelativeFiles(['C:\\repo'], [
      'C:\\repo-backup\\a.ts',
      'D:\\repo\\a.ts',
    ])).toEqual([]);
  });
});

describe('namesSameRepoFile — does the plan still point at a file that moved?', () => {
  it('matches the spellings git and the payload each use for one file', () => {
    expect(namesSameRepoFile('app/src/x.ts', 'app/src/x.ts')).toBe(true);
    expect(namesSameRepoFile('src/x.ts', 'app/src/x.ts')).toBe(true);   // payload named it from a subdir
    expect(namesSameRepoFile('app/src/x.ts', 'src/x.ts')).toBe(true);   // and the other way round
  });

  it('matches a backslash-spelled path against what git reports, which is always slashes', () => {
    // An agent writing NEXT on Windows types `app\src\x.ts`; git says `app/src/x.ts`. They never
    // compared equal, so the drift warning was silent on every Windows handoff.
    expect(namesSameRepoFile('app\\src\\x.ts', 'app/src/x.ts')).toBe(true);
    expect(namesSameRepoFile('src\\x.ts', 'app/src/x.ts')).toBe(true);
  });

  it('does not re-spell a Linux filename that really contains a backslash', () => {
    // `src/back\slash.ts` already holds a '/', so it is compared as written and still matches
    // itself — and is never turned into the `src/back/slash.ts` that does not exist.
    expect(namesSameRepoFile('src/back\\slash.ts', 'src/back\\slash.ts')).toBe(true);
    expect(namesSameRepoFile('src/back\\slash.ts', 'src/back/slash.ts')).toBe(false);
  });

  it('does not pair two different files that merely end alike', () => {
    // The suffix has to land on a segment boundary. Without that, a plan naming `x.ts` reports
    // drift because an unrelated `xx.ts` changed — a warning about a file nobody mentioned.
    expect(namesSameRepoFile('x.ts', 'app/src/xx.ts')).toBe(false);
    expect(namesSameRepoFile('app/src/x.ts', 'app/src/xx.ts')).toBe(false);
    expect(namesSameRepoFile('other/x.ts', 'app/src/x.ts')).toBe(false);
    expect(namesSameRepoFile('x.ts', 'app/src/x.ts')).toBe(true);
  });
});
