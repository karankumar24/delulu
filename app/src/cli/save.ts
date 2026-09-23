// delulu handoff: saves this session for the next one. The agent has already named the session and
// written its note to .delulu-handoff/<name>.md. This reads the transcript and git, and writes one handoff file, asking
// nothing. A handoff is about the one session it saves: nothing is copied from earlier handoffs.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { git, keepOutOfGit, uncommitted } from '../transcript/git';
import { repoKey } from '../transcript/repo-key';
import { isProgram } from './entry';
import { extractSession } from './extract';
import type { Extraction } from './extract';
import { makeRedactor } from './redact';
import { resolveLog } from './resolve-log';
import { handoffLabel } from './dates';
import { handoffName, nameInTitle, takeName } from './name';
import { imageFiles, renderHandoff } from './write';

const KEEP = 15;
const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

/** Handoff folders, oldest first by when they were created: folder names are local time and can mislead. */
function handoffFolders(base: string): string[] {
  let names: string[];
  try { names = readdirSync(base); } catch { return []; }
  return names
    .filter((f) => STAMPED.test(f) && existsSync(join(base, f, 'handoff.md')))
    .map((f) => { let t = 0; try { const s = statSync(join(base, f)); t = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs; } catch { /* keep 0 */ } return { f, t }; })
    .sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : 1))
    .map((x) => x.f);
}

function fail(message: string): void {
  process.stdout.write(`delulu handoff: ${message}\n`);
  process.exitCode = 1;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const k = argv.lastIndexOf(name); return k >= 0 ? argv[k + 1] : undefined; };
  // The session's name, which is also its note's file name: plain words and hyphens, so never a path.
  const named = argv.find((a, k) => !a.startsWith('--') && !argv[k - 1]?.startsWith('--') && /^[\p{L}\p{N}][\p{L}\p{N}-]{0,59}$/u.test(a));
  const where = flag('--repo') ?? process.cwd();
  let repo: string;
  try { repo = repoKey(where); } catch { return fail(`not a readable folder: ${where}. Nothing was saved.`); }
  // Before anything else, even a check that can fail: the agent's note is already on disk and must
  // never be one commit away.
  const ignored = keepOutOfGit(repo);
  const log = flag('--log') ?? resolveLog(repo, where);
  if (!log || !existsSync(log)) return fail("could not find this session's transcript. Nothing was saved. Run it again with --log <path to the session .jsonl>.");
  let siblings: string[] = [];
  try { siblings = readdirSync(dirname(log)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dirname(log), f)); } catch { /* no siblings */ }
  const ex = extractSession(log, { siblings });
  if (!ex.turns.some((t) => t.kind === 'said' || t.kind === 'asked')) return fail('this session has no messages from the user yet, so there is nothing to hand off. Nothing was saved.');

  const base = join(repo, '.delulu-handoff');
  // A link here would send writes, and the pruning of old handoffs, somewhere outside this folder.
  try { if (lstatSync(base).isSymbolicLink()) return fail('.delulu-handoff is a link to somewhere else, so nothing was saved. Replace it with a plain folder.'); } catch { /* not there yet */ }
  // Each session's note is named after it, so two sessions saving in one folder never take each other's.
  // note-<session id>.md is where the command asked for it before names; a plain note.md comes last.
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const candidates = [...(named ? [join(base, `${named}.md`)] : []),
    ...(sid && /^[A-Za-z0-9-]{8,}$/.test(sid) ? [join(base, `note-${sid}.md`)] : []), join(base, 'note.md')];
  // A note older than this session belongs to an earlier save that never finished, not to this one.
  let note = '';
  let notePath = candidates[0];
  for (const p of candidates) {
    try {
      if (statSync(p).mtimeMs < (ex.startedAt ? Date.parse(ex.startedAt) : 0)) continue;
      note = readFileSync(p, 'utf8').trim();
      notePath = p;
      break;
    } catch { /* not here */ }
  }

  const typed = ex.turns.flatMap((t) => (t.kind === 'said' ? [...t.text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0]) : []));
  const redact = makeRedactor({ ownEmail: git(repo, ['config', 'user.email']), typedEmails: typed });
  // Read before anything is written, so delulu's own files never count as the user's changes.
  const commit = git(repo, ['rev-parse', '--short', 'HEAD']);
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']) || (commit ? `detached at ${commit}` : undefined);
  const dirty = uncommitted(repo);
  const since = ex.startedAt ? git(repo, ['log', `--since=${ex.startedAt}`, '--format=%h%x09%s', '-n', '30']) : undefined;
  const commits = (since ?? '').split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; });

  mkdirSync(base, { recursive: true, mode: 0o700 });
  // The agent's Write may have created the folder first, with the default mode.
  chmodSync(base, 0o700);
  const now = new Date();
  let folder = stamp(now);
  for (let n = 2; ; n++) {
    try { mkdirSync(join(base, folder), { mode: 0o700 }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      folder = `${stamp(now)}-${n}`;
    }
  }
  const { name: chosenName, rest } = takeName(note);
  const cleaned = handoffName(redact(named || chosenName));
  const name = cleaned ? uniqueName(cleaned, base, folder) : '';
  const out = renderHandoff({ project: basename(repo), name: name || undefined, savedAt: now, transcript: log.replace(homedir(), '~'), folder, ex,
    note: rest || undefined, redact, repo: { branch, commit, uncommitted: dirty, commits } });
  writeFileSync(join(base, folder, 'handoff.md'), out, { mode: 0o600 });
  const missed = writeImages(join(base, folder), ex);
  if (note) rmSync(notePath, { force: true });

  const lines = [`delulu saved this session: ${name || handoffLabel(folder, now)}`];
  if (!rest) lines.push(`No summary was written, so the next session gets the session without one, and no older handoff was removed. Write ${notePath.replace(`${repo}/`, '')} and save again to add it.`);
  if (ignored) lines.push(ignored);
  if (missed) lines.push(`${missed} image(s) could not be saved.`);
  // A handoff without a summary is a weaker one; it never pushes out a complete one.
  if (rest) prune(base, folder);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** The name, or the name with -2, -3 and so on when another handoff here already has it. */
function uniqueName(name: string, base: string, self: string): string {
  const taken = new Set(handoffFolders(base).filter((f) => f !== self).map((f) => {
    try { return nameInTitle(readFileSync(join(base, f, 'handoff.md'), 'utf8').slice(0, 500)); } catch { return undefined; }
  }));
  let n = 1;
  while (taken.has(n === 1 ? name : `${name}-${n}`)) n++;
  return n === 1 ? name : `${name}-${n}`;
}

/** Keeps the newest handoffs. */
function prune(base: string, keep: string): void {
  const older = handoffFolders(base).filter((f) => f !== keep);
  const gone = older.slice(0, Math.max(0, older.length - (KEEP - 1)));
  for (const f of gone) { try { rmSync(join(base, f), { recursive: true, force: true }); } catch { /* housekeeping only */ } }
}

/** Saves the images the user sent beside the handoff, under the names the handoff points to. */
function writeImages(folder: string, ex: Extraction): number {
  let missed = 0;
  const names = imageFiles(ex);
  for (const t of ex.turns) {
    if (t.kind !== 'said' || !t.images?.length) continue;
    t.images.forEach((im, k) => {
      try {
        mkdirSync(join(folder, 'images'), { recursive: true, mode: 0o700 });
        writeFileSync(join(folder, 'images', names.get(t.line)?.[k] ?? `image-${t.line}-${k + 1}`), Buffer.from(im.data, 'base64'), { mode: 0o600 });
      } catch { missed++; }
    });
  }
  return missed;
}

try {
  if (isProgram(import.meta.url)) main();
} catch (e) {
  fail(`could not save (${e instanceof Error ? e.message : 'unknown error'}). Check .delulu-handoff/ before assuming nothing was written.`);
}
