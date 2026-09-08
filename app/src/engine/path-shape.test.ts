// What these tests DO and DO NOT prove, stated up front because there is no Windows machine here.
//
// PROVEN, by running: given a Windows-shaped STRING, each function below returns the right answer.
// Every function takes its flavour from its arguments, so driving them with `C:\repo\src\a.ts` on
// macOS exercises the same code Windows would run — that is the whole reason the logic was moved
// out of `buildState` into functions that take strings.
//
// NOT PROVEN by anything, here or elsewhere: that Claude Code on Windows writes `cwd` and
// `file_path` in these shapes, that `repoKey` returns `C:\repo` there, that the `.cmd` launcher
// starts node, or that a capture end-to-end produces a correct payload on Windows. Those are
// reasoned only. Green here is not a claim that Windows works.
//
// The POSIX side is tested just as hard, in both directions: a Linux filename containing a
// backslash (which is legal, and which this repo has already shipped one fix for) must survive
// untouched, and no Windows accommodation may make a POSIX answer differ from what the
// `split('/')` / `startsWith('/')` expressions these functions replaced used to return.

import { describe, it, expect } from 'vitest';
import {
  absolutePath,
  baseNameOf,
  hasSegment,
  pathStyleOf,
  relativeUnder,
  sameFileKey,
  stripLongPrefix,
  tailSegments,
} from './path-shape';

const HOME_POSIX = '/Users/me';
const HOME_WIN = 'C:\\Users\\me';

describe('pathStyleOf — the flavour is a property of the string, not of this machine', () => {
  it('reads the Windows shapes off the head of the string', () => {
    expect(pathStyleOf('C:\\repo\\src\\a.ts')).toBe('win32');
    expect(pathStyleOf('C:/repo/src/a.ts')).toBe('win32');      // git on Windows prints these
    expect(pathStyleOf('c:\\repo')).toBe('win32');
    expect(pathStyleOf('C:a.ts')).toBe('win32');                 // drive-relative
    expect(pathStyleOf('\\\\?\\C:\\repo\\a.ts')).toBe('win32');  // extended-length
    expect(pathStyleOf('\\\\server\\share\\proj\\a.ts')).toBe('win32');
  });

  it('reads a leading slash as POSIX, and never re-reads a backslash as a separator', () => {
    // `src/back\slash.ts` is a REAL Linux filename. Calling it a Windows path here would hand every
    // downstream function a wrong split, which is the same class of damage as git's C-quoting that
    // `-z` was added upstream to stop.
    expect(pathStyleOf('/repo/src/back\\slash.ts')).toBe('posix');
    expect(pathStyleOf('/repo/a.ts')).toBe('posix');
  });

  it('says undefined rather than guessing at a bare relative path', () => {
    expect(pathStyleOf('src/a.ts')).toBeUndefined();
    expect(pathStyleOf('src\\a.ts')).toBeUndefined();
    expect(pathStyleOf('')).toBeUndefined();
  });
});

describe('stripLongPrefix', () => {
  it('drops the extended-length and device prefixes, and rebuilds UNC', () => {
    // node does NOT do this: win32.relative('\\\\?\\C:\\repo', 'C:\\repo\\a.ts') returns an
    // absolute path, i.e. "not under the root", which is the empty-file-list bug by another route.
    expect(stripLongPrefix('\\\\?\\C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts');
    expect(stripLongPrefix('\\\\.\\C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts');
    expect(stripLongPrefix('\\\\?\\UNC\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
  });

  it('leaves a plain UNC path and every POSIX path alone', () => {
    expect(stripLongPrefix('\\\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
    expect(stripLongPrefix('/repo/a.ts')).toBe('/repo/a.ts');
  });
});

describe('baseNameOf / tailSegments — the label the index and WHAT FAILED print', () => {
  it('finds the filename in a Windows path', () => {
    // `file.split('/').pop()` returned the WHOLE path, which then got clipped at 60 characters, so
    // an index anchor read as a truncated directory instead of `a.ts`.
    expect(baseNameOf('C:\\repo\\src\\a.ts')).toBe('a.ts');
    expect(baseNameOf('C:/repo/src/a.ts')).toBe('a.ts');
    expect(baseNameOf('\\\\server\\share\\proj\\a.ts')).toBe('a.ts');
    expect(baseNameOf('\\\\?\\C:\\repo\\a.ts')).toBe('a.ts');
  });

  it('is byte-identical to split("/").pop() on every POSIX path, backslashes included', () => {
    for (const p of ['/repo/src/a.ts', '/repo/src/back\\slash.ts', 'a.ts', '/repo/dir/']) {
      expect(baseNameOf(p)).toBe(p.split('/').pop());
    }
  });

  it('shortens a Windows path to its last two segments, printed with slashes', () => {
    // Display form: git, the diff lines beneath it and resume's drift check all speak '/'.
    expect(tailSegments('C:\\repo\\src\\a.ts', 2)).toBe('src/a.ts');
    expect(tailSegments('/repo/src/a.ts', 2)).toBe('src/a.ts');
    expect(tailSegments('/repo/src/back\\slash.ts', 2)).toBe('src/back\\slash.ts');
  });
});

describe('absolutePath — anchoring a path a tool reported', () => {
  it('keeps a Windows absolute path absolute instead of dropping it', () => {
    // `raw.startsWith('/')` was false for `C:\…`, so with no cwd the path was thrown away entirely
    // and WHAT FAILED lost its disk check for it.
    expect(absolutePath('C:\\repo\\src\\a.ts', undefined, HOME_WIN)).toBe('C:\\repo\\src\\a.ts');
    expect(absolutePath('C:/repo/src/a.ts', undefined, HOME_WIN)).toBe('C:\\repo\\src\\a.ts');
    expect(absolutePath('\\\\server\\share\\p\\a.ts', undefined, HOME_WIN)).toBe('\\\\server\\share\\p\\a.ts');
    expect(absolutePath('\\\\?\\C:\\repo\\a.ts', undefined, HOME_WIN)).toBe('C:\\repo\\a.ts');
  });

  it('resolves a relative Windows path against the recorded cwd, by Windows rules', () => {
    expect(absolutePath('src\\a.ts', 'C:\\repo', HOME_WIN)).toBe('C:\\repo\\src\\a.ts');
    expect(absolutePath('.\\sub\\..\\a.ts', 'C:\\repo', HOME_WIN)).toBe('C:\\repo\\a.ts');
    // Drive-relative: `C:a.ts` means "the current directory on C:", which only the cwd supplies.
    expect(absolutePath('C:a.ts', 'C:\\repo', HOME_WIN)).toBe('C:\\repo\\a.ts');
  });

  it('expands ~ against the running machine, in that machine\u2019s flavour', () => {
    expect(absolutePath('~/.zshrc', '/repo', HOME_POSIX)).toBe('/Users/me/.zshrc');
    expect(absolutePath('~\\.gitconfig', 'C:\\repo', HOME_WIN)).toBe('C:\\Users\\me\\.gitconfig');
    // A POSIX file really named `~\x` is a file, not a home reference, and must not be expanded.
    expect(absolutePath('~\\x', '/repo', HOME_POSIX)).toBe('/repo/~\\x');
  });

  it('refuses to invent an anchor when there is none', () => {
    expect(absolutePath('src/a.ts', undefined, HOME_POSIX)).toBeUndefined();
    expect(absolutePath('C:a.ts', undefined, HOME_WIN)).toBeUndefined();
    expect(absolutePath('', 'C:\\repo', HOME_WIN)).toBeUndefined();
  });

  it('answers exactly as the old POSIX code did for POSIX input', () => {
    expect(absolutePath('/repo/a.ts', undefined, HOME_POSIX)).toBe('/repo/a.ts');
    expect(absolutePath('./sub/../a.ts', '/repo', HOME_POSIX)).toBe('/repo/a.ts');
    expect(absolutePath('/repo/back\\slash.ts', '/repo', HOME_POSIX)).toBe('/repo/back\\slash.ts');
  });
});

describe('relativeUnder — the test that was empty on Windows', () => {
  it('finds a file under a Windows repo root', () => {
    expect(relativeUnder('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeUnder('C:\\repo', 'C:\\repo\\a.ts')).toBe('a.ts');
    expect(relativeUnder('\\\\server\\share\\proj', '\\\\server\\share\\proj\\src\\a.ts')).toBe('src/a.ts');
  });

  it('matches across the separator and case spellings Windows treats as one path', () => {
    // git on Windows prints `C:/repo` from rev-parse while the transcript records `C:\repo`; a raw
    // prefix test calls those two different repositories and files nothing.
    expect(relativeUnder('C:/repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeUnder('C:\\repo', 'C:/repo/src/a.ts')).toBe('src/a.ts');
    expect(relativeUnder('C:\\Repo', 'c:\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeUnder('\\\\?\\C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  it('refuses a sibling, another drive, and a relative path', () => {
    expect(relativeUnder('C:\\repo', 'C:\\repo-backup\\a.ts')).toBeUndefined();
    expect(relativeUnder('C:\\repo', 'D:\\repo\\a.ts')).toBeUndefined();
    expect(relativeUnder('C:\\repo', 'src\\a.ts')).toBeUndefined();
    expect(relativeUnder('/repo', '/repo-backup/a.ts')).toBeUndefined();
  });

  it('stays case-SENSITIVE on POSIX, where two cases are two files', () => {
    expect(relativeUnder('/repo', '/Repo/a.ts')).toBeUndefined();
    expect(relativeUnder('/repo', '/repo/a.ts')).toBe('a.ts');
  });

  it('leaves a POSIX filename containing a backslash exactly as it was', () => {
    // Blanket backslash-to-slash would print `src/back/slash.ts` — a path that does not exist —
    // under a heading promising it was read from disk.
    expect(relativeUnder('/repo', '/repo/src/back\\slash.ts')).toBe('src/back\\slash.ts');
  });

  it('says "" for the root itself, which callers must not treat as a file', () => {
    expect(relativeUnder('C:\\repo', 'C:\\repo')).toBe('');
    expect(relativeUnder('/repo', '/repo')).toBe('');
    expect(relativeUnder('/repo/', '/repo/a.ts')).toBe('a.ts');
  });
});

describe('sameFileKey — one file, however it was spelled', () => {
  it('folds the spellings Windows considers equal', () => {
    expect(sameFileKey('C:\\Repo\\A.ts')).toBe(sameFileKey('c:\\repo\\a.ts'));
    expect(sameFileKey('C:\\repo\\a.ts')).toBe(sameFileKey('C:/repo/a.ts'));
    expect(sameFileKey('C:\\repo\\a.ts')).toBe(sameFileKey('\\\\?\\C:\\repo\\a.ts'));
  });

  it('keeps two POSIX files that differ only in case apart', () => {
    expect(sameFileKey('/repo/A.ts')).not.toBe(sameFileKey('/repo/a.ts'));
  });
});

describe('hasSegment', () => {
  it('matches a whole segment, not a substring of one', () => {
    expect(hasSegment('.delulu-handoff/2026-01-01/payload.md', '.delulu-handoff')).toBe(true);
    expect(hasSegment('src/.delulu-handoff-notes/x.md', '.delulu-handoff')).toBe(false);
  });
});
