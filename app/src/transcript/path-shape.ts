// What a path string from a transcript means. The separator belongs to the machine that wrote the
// session, not the one reading it, so every function takes its platform from the strings it is given.

import { win32, posix } from 'node:path';

export type PathStyle = 'win32' | 'posix';

/** The extended-length and device prefixes: `\\?\C:\x`, `\\?\UNC\srv\share\x`, `\\.\C:\x`. */
const LONG_PREFIX = /^\\\\[?.]\\(UNC\\)?/i;

/**
 * The plain path an extended-length one names. node leaves the prefix on, and `win32.relative` then
 * reads the path as outside its own root.
 */
export function stripLongPrefix(p: string): string {
  const m = LONG_PREFIX.exec(p);
  if (!m) return p;
  return m[1] ? `\\\\${p.slice(m[0].length)}` : p.slice(m[0].length);
}

/**
 * The platform this one string proves, or undefined. Only the head is evidence: a drive letter or UNC
 * prefix means Windows, a leading '/' means POSIX. A backslash elsewhere is a legal POSIX filename
 * character, and a bare relative path cannot be decided.
 */
export function pathStyleOf(p: string): PathStyle | undefined {
  if (!p) return undefined;
  if (/^\\\\/.test(p)) return 'win32';         // \\server\share, \\?\C:\, \\.\
  if (/^[A-Za-z]:/.test(p)) return 'win32';    // C:\x, C:/x, and drive-relative C:x
  if (p.startsWith('/')) return 'posix';
  return undefined;
}

/**
 * The platform of the first string that proves one, POSIX when none does. Not `process.platform`, so
 * the functions stay pure and tests can drive Windows paths on any machine.
 */
function pathStyle(...candidates: (string | undefined)[]): PathStyle {
  for (const c of candidates) {
    const s = c === undefined ? undefined : pathStyleOf(c);
    if (s) return s;
  }
  return 'posix';
}

const impl = (style: PathStyle) => (style === 'win32' ? win32 : posix);

/**
 * The absolute form of a path a tool reported, or undefined when nothing anchors it. `home` is the
 * running machine's, since `~` is the one part that refers to here. `~\` expands only when the paths
 * around it are Windows paths, so a POSIX file named `~\x` is left alone.
 */
export function absolutePath(raw: string, cwd: string | undefined, home: string): string | undefined {
  if (!raw) return undefined;
  const style = pathStyle(cwd, raw, home);
  const n = impl(style);
  if (home) {
    const tilde = raw.startsWith('~/') || (style === 'win32' && raw.startsWith('~\\'));
    // resolve() does not expand `~`.
    if (tilde) return n.normalize(n.join(stripLongPrefix(home), raw.slice(2)));
  }
  const p = stripLongPrefix(raw);
  if (n.isAbsolute(p)) return n.normalize(p);
  // `C:a.ts` is relative to the current directory on C:, which only the recorded cwd supplies.
  if (cwd) return n.resolve(stripLongPrefix(cwd), p);
  return undefined;
}

/** Windows filesystems are case-insensitive; POSIX ones are not, and folding there merges two files. */
const fold = (s: string, style: PathStyle): string => (style === 'win32' ? s.toLowerCase() : s);

/** The key two spellings of one file share: case and separators fold on Windows, never on POSIX. */
export function sameFileKey(p: string): string {
  const style = pathStyle(p);
  return fold(impl(style).normalize(stripLongPrefix(p)), style);
}
