// delulu handoff: saves this session for the next one. The agent has already written its note to
// .delulu-handoff/note.md. This reads the transcript, git and the previous handoff's rules, and
// writes one handoff file, asking nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { git, uncommitted } from '../transcript/git';
import { repoKey } from '../transcript/repo-key';
import { isProgram } from './entry';
import { extractSession } from './extract';
import type { Extraction } from './extract';
import { makeRedactor } from './redact';
import { resolveLog } from './resolve-log';
import { mergeRules, parseNote, previousRules } from './rules';
import { imageExt, renderHandoff } from './write';

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
  const where = flag('--repo') ?? process.cwd();
  let repo: string;
  try { repo = repoKey(where); } catch { return fail(`not a readable folder: ${where}. Nothing was saved.`); }
  const log = flag('--log') ?? resolveLog(repo, where);
  if (!log || !existsSync(log)) return fail("could not find this session's transcript. Nothing was saved. Run it again with --log <path to the session .jsonl>.");
  let siblings: string[] = [];
  try { siblings = readdirSync(dirname(log)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dirname(log), f)); } catch { /* no siblings */ }
  const ex = extractSession(log, { siblings });
  if (!ex.turns.some((t) => t.kind === 'said' || t.kind === 'asked')) return fail('this session has no messages from the user yet, so there is nothing to hand off. Nothing was saved.');

  const base = join(repo, '.delulu-handoff');
  const notePath = join(base, 'note.md');
  // A note older than this session belongs to an earlier save that never finished, not to this one.
  let noteText = '';
  try { if (statSync(notePath).mtimeMs >= (ex.startedAt ? Date.parse(ex.startedAt) : 0)) noteText = readFileSync(notePath, 'utf8'); } catch { /* no note */ }
  const note = parseNote(noteText);
  const merged = mergeRules(previousRules(base, handoffFolders(base).at(-1)), note);

  const typed = ex.turns.flatMap((t) => (t.kind === 'said' ? [...t.text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0]) : []));
  const redact = makeRedactor({ ownEmail: git(repo, ['config', 'user.email']), typedEmails: typed });
  // Read before anything is written, so delulu's own files never count as the user's changes.
  const commit = git(repo, ['rev-parse', '--short', 'HEAD']);
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']) || (commit ? `detached at ${commit}` : undefined);
  const dirty = uncommitted(repo);
  const since = ex.startedAt ? git(repo, ['log', `--since=${ex.startedAt}`, '--format=%h%x09%s', '-n', '30']) : undefined;
  const commits = (since ?? '').split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; });

  mkdirSync(base, { recursive: true, mode: 0o700 });
  const now = new Date();
  let folder = stamp(now);
  for (let n = 2; ; n++) {
    try { mkdirSync(join(base, folder), { mode: 0o700 }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      folder = `${stamp(now)}-${n}`;
    }
  }
  const out = renderHandoff({ project: basename(repo), savedAt: now, transcript: log.replace(homedir(), '~'), folder, ex,
    note: note.summary || undefined, rules: merged.rules, redact,
    repo: { branch, commit, uncommitted: dirty, commits } });
  writeFileSync(join(base, folder, 'handoff.md'), out, { mode: 0o600 });
  const missed = writeImages(join(base, folder), ex);
  rmSync(notePath, { force: true });

  const lines = [`delulu saved this session: .delulu-handoff/${folder}/handoff.md (about ${(Buffer.byteLength(out) / 2500).toFixed(1)}k tokens)`];
  if (!note.summary) lines.push('No summary was written, so the next session gets the session without one. Write .delulu-handoff/note.md and save again to add it.');
  for (const r of merged.restored) lines.push(`Put back a rule the note left out without a reason: ${r}`);
  for (const d of merged.dropped) lines.push(`Dropped a rule: ${d}`);
  const ignored = keepOutOfGit(repo);
  if (ignored) lines.push(ignored);
  if (missed) lines.push(`${missed} image(s) could not be saved.`);
  const pruned = prune(base, folder);
  if (pruned) lines.push(pruned);
  lines.push('In a fresh session, type /delulu:resume to carry on.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Adds .delulu-handoff/ to .gitignore, or says plainly why nothing keeps the handoffs out of git. */
function keepOutOfGit(repo: string): string {
  if (git(repo, ['rev-parse', '--git-dir']) === undefined) return 'This folder is not a git repository, so nothing keeps .delulu-handoff/ out of copies of it.';
  const file = join(repo, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^[ \t]*\.delulu-handoff\/?[ \t\r]*$/m.test(current)) return '';
  try {
    writeFileSync(file, `${current && !current.endsWith('\n') ? `${current}\n` : current}.delulu-handoff/\n`);
    return 'Added .delulu-handoff/ to .gitignore.';
  } catch { return 'Could not add .delulu-handoff/ to .gitignore; add it before committing.'; }
}

/** Keeps the newest handoffs. */
function prune(base: string, keep: string): string {
  const older = handoffFolders(base).filter((f) => f !== keep);
  const gone = older.slice(0, Math.max(0, older.length - (KEEP - 1)));
  for (const f of gone) { try { rmSync(join(base, f), { recursive: true, force: true }); } catch { /* housekeeping only */ } }
  return gone.length ? `Removed ${gone.length} old handoff(s), keeping the newest ${KEEP}.` : '';
}

/** Saves the images the user sent beside the handoff, under the names the handoff points to. */
function writeImages(folder: string, ex: Extraction): number {
  let missed = 0;
  for (const t of ex.turns) {
    if (t.kind !== 'said' || !t.images?.length) continue;
    t.images.forEach((im, k) => {
      try {
        mkdirSync(join(folder, 'images'), { recursive: true, mode: 0o700 });
        writeFileSync(join(folder, 'images', `L${t.line}-${k + 1}.${imageExt(im.mediaType)}`), Buffer.from(im.data, 'base64'), { mode: 0o600 });
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
