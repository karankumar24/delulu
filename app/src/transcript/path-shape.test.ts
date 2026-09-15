// Path rules driven with Windows and POSIX strings alike, since each function takes its platform from its arguments.
import { describe, it, expect } from 'vitest';
import { absolutePath, pathStyleOf, sameFileKey, stripLongPrefix } from './path-shape';

const HOME_POSIX = '/Users/me';
const HOME_WIN = 'C:\\Users\\me';

describe('pathStyleOf: the platform comes from the string, not this machine', () => {
  it('reads the Windows shapes off the head of the string', () => {
    expect(pathStyleOf('C:\\repo\\src\\a.ts')).toBe('win32');
    expect(pathStyleOf('C:/repo/src/a.ts')).toBe('win32');      // git on Windows prints these
    expect(pathStyleOf('c:\\repo')).toBe('win32');
    expect(pathStyleOf('C:a.ts')).toBe('win32');                 // drive-relative
    expect(pathStyleOf('\\\\?\\C:\\repo\\a.ts')).toBe('win32');  // extended-length
    expect(pathStyleOf('\\\\server\\share\\proj\\a.ts')).toBe('win32');
  });

  it('reads a leading slash as POSIX, and never re-reads a backslash as a separator', () => {
    // A backslash is a legal character in a POSIX filename.
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
    expect(stripLongPrefix('\\\\?\\C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts');
    expect(stripLongPrefix('\\\\.\\C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts');
    expect(stripLongPrefix('\\\\?\\UNC\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
  });

  it('leaves a plain UNC path and every POSIX path alone', () => {
    expect(stripLongPrefix('\\\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
    expect(stripLongPrefix('/repo/a.ts')).toBe('/repo/a.ts');
  });
});

describe('absolutePath: anchoring a path a tool reported', () => {
  it('keeps a Windows absolute path absolute instead of dropping it', () => {
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

  it("expands ~ against the running machine's home", () => {
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

  it('resolves POSIX paths the POSIX way', () => {
    expect(absolutePath('/repo/a.ts', undefined, HOME_POSIX)).toBe('/repo/a.ts');
    expect(absolutePath('./sub/../a.ts', '/repo', HOME_POSIX)).toBe('/repo/a.ts');
    expect(absolutePath('/repo/back\\slash.ts', '/repo', HOME_POSIX)).toBe('/repo/back\\slash.ts');
  });
});

describe('sameFileKey: one file, however it was spelled', () => {
  it('folds the spellings Windows considers equal', () => {
    expect(sameFileKey('C:\\Repo\\A.ts')).toBe(sameFileKey('c:\\repo\\a.ts'));
    expect(sameFileKey('C:\\repo\\a.ts')).toBe(sameFileKey('C:/repo/a.ts'));
    expect(sameFileKey('C:\\repo\\a.ts')).toBe(sameFileKey('\\\\?\\C:\\repo\\a.ts'));
  });

  it('keeps two POSIX files that differ only in case apart', () => {
    expect(sameFileKey('/repo/A.ts')).not.toBe(sameFileKey('/repo/a.ts'));
  });
});
