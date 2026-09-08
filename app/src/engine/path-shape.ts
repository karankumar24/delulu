// delulu engine — deciding what a path STRING means, when the string came from a transcript.
//
// Every path delulu reasons about arrives as text: `file_path` off a tool call, `cwd` off the
// record that carried it, a repo root out of `git rev-parse`. The code that read them was written
// on a Mac and said so in the only way that matters — `f.startsWith(pre + '/')`, `p.split('/')`,
// `p.startsWith('/')`. On `C:\repo` NONE of those fire, so:
//   · `under()` matched nothing and "Files touched via Write/Edit" was EMPTY in every Windows
//     capture, on the same line as `tree **7 uncommitted entries**` — the block that exists to say
//     what the session changed, silently naming none of it, inside the zone labelled engine-verified;
//   · a `C:\…` path failed `startsWith('/')`, so WHAT FAILED could not resolve it, could not ask
//     disk about it, and lost the "that file still does not exist" answer entirely;
//   · `repo.split('/').pop()` returned the WHOLE path, so every payload title read
//     `# delulu handoff — C:\Users\me\proj`.
// The `.cmd` launcher shipped on top of that, and README called the two slash commands "the whole
// product" and said they work.
//
// The design mistake underneath is subtler than "use path.win32". The separator is a property of
// the DATA, not of the machine delulu is running on: these strings were written by whichever
// machine held the session. A function that hardcodes `path.win32` is exactly as wrong as one that
// hardcodes '/'. So every function here decides the flavour from the strings it was handed, and
// then delegates to node's own `path.win32` / `path.posix` rather than re-implementing them.
//
// VERIFIED / NOT VERIFIED — say it plainly, because nobody here has a Windows machine.
// `path-shape.test.ts` runs these functions against Windows-shaped strings ON macOS, so the RULES
// below are executed and checked. What is NOT checked by anything: that Claude Code on Windows
// writes `cwd` and `file_path` in the shapes assumed here, that `git rev-parse --show-toplevel`
// plus `realpathSync` hands back `C:\repo`, and that the `.cmd` launcher starts node at all. Those
// remain reasoned-only. Nothing in this file entitles anyone to claim Windows works end to end.

import { win32, posix } from 'node:path';

export type PathStyle = 'win32' | 'posix';

/** `\\?\C:\x`, `\\?\UNC\srv\share\x`, `\\.\C:\x` — the extended-length and device forms. */
const LONG_PREFIX = /^\\\\[?.]\\(UNC\\)?/i;

/**
 * The extended-length prefix names the same file as the plain path, and node does not strip it:
 * `win32.relative('\\\\?\\C:\\repo', 'C:\\repo\\a.ts')` returns an ABSOLUTE path, i.e. "not under
 * the root", which is the same empty-file-list failure as before by another route. Measured on
 * node 22 while writing this.
 */
export function stripLongPrefix(p: string): string {
  const m = LONG_PREFIX.exec(p);
  if (!m) return p;
  return m[1] ? `\\\\${p.slice(m[0].length)}` : p.slice(m[0].length);
}

/**
 * What this ONE string proves about its flavour, or nothing.
 *
 * A backslash in the middle proves nothing and must not be read as a separator: a Linux filename
 * may legally contain one, this repo has already shipped a fix for `src/back\slash.ts` being
 * mangled by git's C-quoting, and re-splitting it here would re-invent that bug from the other
 * side. Only the HEAD of the string is evidence — a drive letter or a UNC/device prefix — and a
 * leading '/' is evidence the other way, because Windows never starts a path with one.
 *
 * A bare relative path (`src\a.ts`, `a.ts`) is genuinely undecidable and returns undefined; the
 * caller supplies a second string (the recorded cwd, the repo root) that does know.
 */
export function pathStyleOf(p: string): PathStyle | undefined {
  if (!p) return undefined;
  if (/^\\\\/.test(p)) return 'win32';         // \\server\share, \\?\C:\, \\.\
  if (/^[A-Za-z]:/.test(p)) return 'win32';    // C:\x, C:/x, and drive-relative C:x
  if (p.startsWith('/')) return 'posix';
  return undefined;
}

/**
 * The flavour to judge these strings by: the first one that actually knows, POSIX if none does.
 *
 * POSIX is the default rather than `process.platform` on purpose. It keeps every function here
 * byte-identical to the `split('/')` / `startsWith('/')` expressions they replaced whenever the
 * input is POSIX-shaped or undecidable — which is the whole of today's user base — and it keeps
 * them PURE, so the tests can drive Windows semantics on a Mac instead of mocking a platform.
 * The undecidable case is also never load-bearing: an unanchored relative path is returned raw by
 * `absolutePath` and cannot be under any root, so no answer depends on the guess.
 */
function pathStyle(...candidates: (string | undefined)[]): PathStyle {
  for (const c of candidates) {
    const s = c === undefined ? undefined : pathStyleOf(c);
    if (s) return s;
  }
  return 'posix';
}

const impl = (style: PathStyle) => (style === 'win32' ? win32 : posix);

/** Split into segments on whatever separates them in THIS flavour. */
function segmentsIn(p: string, style: PathStyle): string[] {
  return style === 'win32' ? stripLongPrefix(p).split(/[\\/]/) : p.split('/');
}

/**
 * The filename. On a POSIX-shaped path this is exactly `p.split('/').pop()`, deliberately including
 * the empty string a trailing slash yields — the call sites already fall back on that.
 *
 * `basename()` from node:path is NOT the same thing and is wrong here: it is the running machine's
 * flavour, so a `C:\repo\a.ts` read on a Mac comes back whole, and the index label that should say
 * `a.ts` says the entire path and then gets clipped at 60 characters.
 */
export function baseNameOf(p: string): string {
  return segmentsIn(p, pathStyle(p)).pop() ?? '';
}

/**
 * The last `count` segments, joined with '/' — the display form used for "enough to grep for, not
 * a wall of directories". Forward slashes on both flavours: this is a label in a markdown document,
 * not a path to open, and `app/src/x.ts` is what git and the payload's other lines already say.
 */
export function tailSegments(p: string, count: number): string {
  return segmentsIn(p, pathStyle(p)).slice(-count).join('/');
}

/**
 * Absolute form of a path a TOOL reported, or undefined when the string cannot be anchored.
 *
 * `home` is passed in rather than read from `os.homedir()` so this stays pure — and it is the
 * RUNNING machine's home on purpose, because `~` is the only part of these strings that refers to
 * here rather than to wherever the transcript was written.
 *
 * `~\` is accepted alongside `~/` only when the surrounding strings are Windows-shaped. That is
 * REASONED, not observed: `~/` in `file_path` was counted on this machine (14 calls), `~\` has
 * never been seen because no Windows transcript has been read. The guard means a POSIX file
 * genuinely named `~\x` is still left alone.
 */
export function absolutePath(raw: string, cwd: string | undefined, home: string): string | undefined {
  if (!raw) return undefined;
  const style = pathStyle(cwd, raw, home);
  const n = impl(style);
  if (home) {
    const tilde = raw.startsWith('~/') || (style === 'win32' && raw.startsWith('~\\'));
    // resolve() does not expand `~`, so the old code built `<cwd>/~/…` — a path that never exists,
    // about which WHAT FAILED then asserted "**that file still does not exist**" while the file sat
    // on disk, in the block advertised as engine-extracted fact.
    if (tilde) return n.normalize(n.join(stripLongPrefix(home), raw.slice(2)));
  }
  const p = stripLongPrefix(raw);
  if (n.isAbsolute(p)) return n.normalize(p);
  // `C:a.ts` is drive-relative: absolute-looking, but it means "the current directory ON C:", which
  // only the recorded cwd can supply. node's own isAbsolute() says false for it, and resolve() with
  // the cwd is the reference implementation of what it means.
  if (cwd) return n.resolve(stripLongPrefix(cwd), p);
  return undefined;
}

/** Windows filesystems are case-insensitive; POSIX ones are not, and folding there merges two files. */
const fold = (s: string, style: PathStyle): string => (style === 'win32' ? s.toLowerCase() : s);

/**
 * The key two spellings of one file share. `C:\Repo\A.ts` and `c:\repo\a.ts` are ONE file on
 * Windows, and the Set in `mutatedFiles` counted them as two — the same over-count its own docstring
 * records being fixed once already for `./sub/../a.ts`. POSIX keys are the string itself.
 */
export function sameFileKey(p: string): string {
  const style = pathStyle(p);
  return fold(impl(style).normalize(stripLongPrefix(p)), style);
}

/**
 * `p` relative to `root` when `p` really is inside it, otherwise undefined. Returns '' for `p` ===
 * `root`. Separators in the answer are always '/', for the reason given on `tailSegments`.
 *
 * This is the function `under()` + `rel()` used to be, and the one that was empty on Windows. Three
 * things it now does that `startsWith(pre + '/')` could not:
 *   · matches across separator spellings — git on Windows reports `C:/repo` where the transcript
 *     says `C:\repo`, and a raw prefix test calls those different repositories;
 *   · matches case-insensitively for Windows paths only, because `C:\Users` and `C:\users` are one
 *     directory there and are two on Linux;
 *   · refuses a sibling: `startsWith` alone matched `/repo-backup/x` against root `/repo`. The
 *     `+ '/'` in the original stopped that and the segment boundary here still does.
 */
export function relativeUnder(root: string, p: string): string | undefined {
  if (!root || !p) return undefined;
  const style = pathStyle(root, p);
  const n = impl(style);
  const rp = stripLongPrefix(p);
  if (!n.isAbsolute(rp)) return undefined; // a relative path is not evidence of being anywhere
  const pp = n.normalize(rp);
  const rr = n.normalize(stripLongPrefix(root));
  if (fold(pp, style) === fold(rr, style)) return '';
  const prefix = rr.endsWith(n.sep) ? rr : rr + n.sep;
  if (pp.length <= prefix.length) return undefined;
  // Compared on an equal-length slice rather than by folding whole strings: lower-casing can CHANGE
  // a string's length (U+0130 is the standard example), and a prefix test that then slices by the
  // root's length would cut in the wrong place.
  if (fold(pp.slice(0, prefix.length), style) !== fold(prefix, style)) return undefined;
  return toDisplaySeparators(pp.slice(prefix.length), style);
}

/**
 * Repo-relative paths are printed with '/' whatever the machine, because that is what git prints,
 * what the payload's diff lines already say, and what resume's drift check intersects them against.
 *
 * Only for a path already KNOWN to be Windows-shaped. A blanket backslash→slash pass would turn the
 * real Linux file `src/back\slash.ts` into `src/back/slash.ts` — a path that does not exist, printed
 * under a heading promising it was read from disk, which is the exact bug `-z` was added upstream to
 * stop git committing.
 */
function toDisplaySeparators(rel: string, style: PathStyle): string {
  return style === 'win32' ? rel.replace(/\\/g, '/') : rel;
}

/** Does this repo-relative path (always '/'-separated, per above) pass through `name`? */
export function hasSegment(rel: string, name: string): boolean {
  return rel.split('/').includes(name);
}
