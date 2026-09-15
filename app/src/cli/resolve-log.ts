// Finds the transcript of the session a command runs in. Claude Code writes one .jsonl per session
// under <config>/projects/<slug>/.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Claude Code keeps its state: `CLAUDE_CONFIG_DIR` when set and not blank, else `~/.claude`. */
export function claudeHome(): string {
  const v = process.env.CLAUDE_CONFIG_DIR?.trim();
  return v ? v : join(homedir(), '.claude');
}

/** The directory holding one subdirectory of transcripts per project. */
export function projectsDir(): string {
  return join(claudeHome(), 'projects');
}

/**
 * The project folder names to try, best first. Claude Code replaces every non-alphanumeric character
 * of the NFC-normalised path with '-' and shortens a long name with a hash. The slashes-only and
 * pre-NFC forms stay as fallbacks for folders made under older rules.
 */
export function projectSlugs(repo: string): string[] {
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
 * The session's transcript: by session id when the environment names one, else the newest in the
 * folder for the launch directory, then for the repo root. Claude Code names the folder after where
 * it was launched, not after the git root.
 */
export function resolveLog(repo: string, cwdHint?: string): string | null {
  // The session id names the transcript exactly; guessing by mtime can pick another window's session.
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
      continue; // no folder under this name
    }
    // A file can vanish between readdir and stat; skip it rather than giving up on the folder.
    const entries: { p: string; mtime: number }[] = [];
    for (const f of names) {
      try { entries.push({ p: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }); } catch { /* skip */ }
    }
    if (entries.length) return entries.sort((x, y) => y.mtime - x.mtime)[0].p;
  }
  return null;
}

/**
 * The transcript named by CLAUDE_CODE_SESSION_ID, searched in every project folder: a linked worktree
 * keeps its transcript in the original project's folder.
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
