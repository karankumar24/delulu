// delulu engine — which of the files the agent touched belong to THIS repo, and what to call them.
//
// Lifted out of `buildState` so it can be tested as what it is: a decision about strings. It used
// to be four closures inside the try/catch of a function that shells out to git and writes a
// markdown block, which meant the only way to exercise it was to capture a whole session — and the
// only repo any test could capture from is the one the test is running on. That is why nobody
// noticed it returns NOTHING when the repo root is `C:\repo`: `f.startsWith(pre + '/')` matches no
// Windows path, so "Files touched via Write/Edit" was absent from every Windows handoff, on the
// same line that reports the tree as dirty.

import { hasSegment, relativeUnder } from './path-shape';

/**
 * A subagent running in a git worktree edits `<repo>/.claude/worktrees/<agent>/app/src/x.ts`, which
 * is the SAME logical file as `app/src/x.ts` and was being listed as a second, separate one —
 * inflating the count and naming a path that does not survive the session, because those worktrees
 * are removed when the agent finishes. Two stored handoffs point into a worktree that no longer
 * exists. Collapse to the path that still means something.
 *
 * The pattern is '/'-separated and stays that way: `relativeUnder` hands back '/' on both flavours,
 * so this now fires on a Windows path too. It did not when the string reaching it was
 * `.claude\worktrees\<agent>\app\src\x.ts`.
 */
const unworktree = (rel: string): string => rel.replace(/^\.claude\/worktrees\/[^/]+\//, '');

/**
 * @param roots  every spelling of this repo's root worth trying (see the /private note at the call
 *               site — macOS realpaths /tmp, transcripts do not).
 * @param files  absolute paths as the transcript reported them.
 *
 * Repo files only — an edit to `~/.claude/CLAUDE.md` is real but is not what this block is about —
 * shown relative for brevity, deduped, first-touch order preserved.
 *
 * The handoff folder is dropped by SEGMENT. The old test was `f.includes('/.delulu-handoff/')`,
 * looking for a separator Windows does not use, so delulu's own artifacts would have been reported
 * back to the user as files they touched.
 */
export function repoRelativeFiles(roots: string[], files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    let rel: string | undefined;
    for (const root of roots) {
      const r = relativeUnder(root, f);
      // '' means the path IS the root — a directory, not a file the next session can open.
      if (r) { rel = r; break; }
    }
    if (rel === undefined || hasSegment(rel, '.delulu-handoff')) continue;
    const s = unworktree(rel);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Does a path NAMED IN THE PAYLOAD refer to the file git has just reported as changed?
 *
 * Suffix either way, because a payload may name `app/src/x.ts` where git says the same, or name it
 * relative to a subdirectory — matching on suffix covers both without inventing a mapping.
 *
 * The Windows half: git reports `app/src/x.ts` on every platform, and an agent typing the NEXT
 * section on Windows types `app\src\x.ts`. Those never compared equal, so the "line numbers in this
 * plan have drifted" warning went silent there — quiet, so not a false claim, but the reader loses
 * the one check that catches a stale instruction.
 *
 * Re-spelling is attempted ONLY for a candidate with no forward slash in it at all. `src/back\slash.ts`
 * is a real Linux filename, it keeps its slash, so it goes down the exact-match route untouched and
 * is never turned into the `src/back/slash.ts` that does not exist.
 */
export function namesSameRepoFile(named: string, changed: string): boolean {
  const forms = named.includes('/') ? [named] : [named, named.replace(/\\/g, '/')];
  return forms.some((n) => n === changed || changed.endsWith(`/${n}`) || n.endsWith(`/${changed}`));
}
