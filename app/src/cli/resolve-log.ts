// Newest session transcript for a repo — shared by `delulu handoff` and `delulu resume`.
// (It said `verify` and `recap`; both commands were deleted in dd98c8e.)
// Claude Code writes one .jsonl per session under <claude config>/projects/<slug>/; the most
// recently modified is the current one.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code keeps its state — `~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise.
 *
 * Hardcoding the home path meant delulu was BLIND for anyone who relocates their config: the
 * transcript lookup and the session-id lookup both searched a directory that holds nothing, so
 * `handoff` resolved no transcript and wrote nothing, every time, for as long as the variable was
 * set. Measured rather than assumed — one `claude -p` run with it set wrote the transcript to
 * `$CLAUDE_CONFIG_DIR/projects/<slug>/<sessionId>.jsonl` and left `~/.claude/projects` untouched.
 *
 * An empty or whitespace-only value is treated as unset: the variable is exported blank often
 * enough (a shell default that never got filled in), and resolving to `/projects` would search a
 * directory that cannot exist while reporting it as the place it looked.
 */
export function claudeHome(): string {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : join(homedir(), '.claude');
}

/** The directory holding one subdirectory of transcripts per project. */
export function projectsDir(): string {
  return join(claudeHome(), 'projects');
}

/**
 * The project-directory names to try, best first.
 *
 * Claude Code slugifies the repo path by replacing EVERY non-alphanumeric character
 * with '-', not just slashes. Verified against all 16 real project directories on this
 * machine: the strict rule matches 16/16; the slashes-only rule missed 3 of 16 — every
 * repo whose path contains a space (`untitled folder 2`) or a dot (`.claude-worktrees/`).
 *
 * That miss was silent and expensive: `resolveLog` returned null, `handoff` printed
 * "no session transcript for this project yet" and wrote nothing, and the agent then
 * hand-wrote the payload under delulu's letterhead — 19 times in one repo, with no
 * verified STATE and no verbatim user block behind any of them.
 *
 * The legacy slug is kept as a fallback so a directory created under the old rule is
 * still found.
 */
export function projectSlugs(repo: string): string[] {
  // Claude Code slugifies `realpath(cwd).normalize('NFC')`, then truncates to 200 characters and
  // appends a hash of the ORIGINAL path. Both steps were missing here, and each one silently sent
  // the lookup to a directory that cannot exist — after which the code quietly fell back to the
  // git-root candidate and captured a different conversation. NFC matters on macOS, where a
  // directory named through Finder (or restored from an archive) routinely arrives decomposed:
  // `café` as `cafe` + combining-accent slugifies to `cafe-`, not `caf-`.
  const nfc = repo.normalize('NFC');
  const strict = truncateSlug(nfc.replace(/[^a-zA-Z0-9]/g, '-'), nfc);
  const legacy = truncateSlug(nfc.replace(/\//g, '-'), nfc);
  const raw = repo.replace(/[^a-zA-Z0-9]/g, '-'); // pre-NFC form, for directories made before this
  return [...new Set([strict, legacy, raw])];
}

/** Claude Code's own rule: names longer than 200 chars keep a 200-char head plus a path hash. */
const SLUG_MAX = 200;
function truncateSlug(slug: string, original: string): string {
  if (slug.length <= SLUG_MAX) return slug;
  let h = 0;
  for (let i = 0; i < original.length; i++) h = (Math.imul(31, h) + original.charCodeAt(i)) | 0;
  return `${slug.slice(0, SLUG_MAX)}-${Math.abs(h).toString(36)}`;
}

/**
 * @param repo    the git top-level (what `repoKey` returns)
 * @param cwdHint the directory the command was actually launched from, when known
 *
 * Claude Code names its project directory after the LAUNCH CWD, not the git root. Running
 * `/delulu:handoff` from `<repo>/app` therefore resolved `-Users-…-delulu` while the real
 * conversation lived in `-Users-…-delulu-app` — a transcript belonging to a DIFFERENT session,
 * found without error, whose messages were then printed under "everything you said this session".
 * The cwd is tried first for that reason; the git root remains the fallback.
 */
export function resolveLog(repo: string, cwdHint?: string): string | null {
  // IDENTITY BEATS GUESSING. Claude Code exports CLAUDE_CODE_SESSION_ID into the environment the
  // command runs in, and names the transcript `<sessionId>.jsonl` — so the current conversation can
  // be named exactly rather than inferred from a directory and an mtime.
  //
  // Guessing was wrong in both directions, and neither was theoretical on the author's machine.
  // Running from `<repo>/app` resolved `-Users-…-delulu-app`, a directory holding 8 unrelated
  // transcripts, and printed a headless eval harness's prompt as "everything you said this session,
  // verbatim". And with two windows open on one repo, whichever wrote last won — so the OTHER
  // window's instructions were captured as this session's. Putting words in the user's mouth is the
  // single failure this tool exists to prevent, so it must not be reached by a heuristic.
  const byId = resolveBySessionId();
  if (byId) return byId;

  const candidates = [
    ...(cwdHint ? projectSlugs(cwdHint) : []),
    ...projectSlugs(repo),
  ].filter((v, i, a) => a.indexOf(v) === i);
  for (const slug of candidates) {
    const dir = join(projectsDir(), slug);
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // directory missing for this candidate — try the next slug rule
    }
    // Per-file guard. One unreadable entry used to abort the whole directory and fall through to
    // the NEXT slug — i.e. to a different project's transcripts. Claude Code renames transcripts to
    // `*.orphaned-*` and prunes old ones, so a file vanishing between readdir and stat is a live
    // race, not a hypothetical. Losing one file must never cost us the right directory.
    const entries: { p: string; mtime: number }[] = [];
    for (const f of names) {
      try { entries.push({ p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }); } catch { /* skip */ }
    }
    if (entries.length) return entries.sort((x, y) => y.mtime - x.mtime)[0].p;
  }
  return null;
}

/**
 * The transcript belonging to THIS conversation, named by the harness rather than inferred.
 *
 * Searched across every project directory, not just the ones our slug rules predict: a linked git
 * worktree keeps its transcript in the ORIGINAL project's directory (with a `relocated` record
 * inside it), so the slug we would compute for the worktree root does not exist at all.
 */
function resolveBySessionId(): string | null {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id || !/^[A-Za-z0-9-]{8,}$/.test(id)) return null;
  const base = projectsDir();
  let dirs: string[];
  try { dirs = readdirSync(base); } catch { return null; }
  for (const d of dirs) {
    const p = join(base, d, `${id}.jsonl`);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}
