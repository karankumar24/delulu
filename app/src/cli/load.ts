// delulu resume: loads the latest handoff into a fresh session. It says when the handoff was saved,
// what changed since, whether a later session was never saved, and how to carry on, then prints the
// handoff. It asks the user nothing.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { git, uncommitted } from '../transcript/git';
import { checkouts, handoffHome, repoKey } from '../transcript/repo-key';
import { clockNow, handoffLabel, stampWhen } from './dates';
import { isProgram } from './entry';
import { ONE_READ_BYTES } from './limits';
import { projectSlugs, projectsDir } from './resolve-log';

const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

interface Handoff { folder: string; file: string; created: number }

/** Handoffs newest first, by when each folder was created: folder names are local time and can mislead. */
function handoffs(base: string): Handoff[] {
  let names: string[];
  try { names = readdirSync(base); } catch { return []; }
  return names.flatMap((folder) => {
    if (!STAMPED.test(folder)) return [];
    const file = join(base, folder, 'handoff.md');
    if (!existsSync(file)) return [];
    let created = 0;
    try { const s = statSync(join(base, folder)); created = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs; } catch { /* keep 0 */ }
    return [{ folder, file, created }];
  }).sort((a, b) => b.created - a.created || (a.folder < b.folder ? 1 : -1));
}

const say = (text: string): void => { process.stdout.write(`${text}\n`); };

function main(): void {
  const argv = process.argv.slice(2);
  let where = process.cwd();
  let list = false;
  const words: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--repo') where = argv[++k] ?? where;
    else if (argv[k] === '--list') list = true;
    else words.push(argv[k]);
  }
  let repo: string;
  try { repo = repoKey(where); } catch { return say(`delulu resume: not a readable folder: ${where}.`); }
  // Handoffs live in the main checkout, so a session in any worktree of the repo finds the same ones.
  const home = handoffHome(repo);
  const base = join(home, '.delulu-handoff');
  const all = handoffs(base);
  const now = new Date();
  if (!all.length) return say('delulu resume: no handoffs yet for this project. Save one with /delulu:handoff at the end of a session.');
  if (list) {
    const rows = all.map((h) => { const w = stampWhen(h.folder, now); return `- ${handoffLabel(h.folder, now)}${w ? ` · ${w.day} at ${w.time}, ${w.age}` : ''}`; });
    return say(['delulu handoffs, newest first (load one with /delulu:resume and its date):', ...rows].join('\n'));
  }

  // Words that name a handoff load it. Anything else is the user's first instruction, not a failed search.
  const said = words.join(' ').trim();
  const q = said.toLowerCase();
  const named = said ? all.find((h) => h.folder.startsWith(said) || handoffLabel(h.folder, now).toLowerCase().includes(q)) : undefined;
  const chosen = named ?? all[0];
  const text = readFileSync(chosen.file, 'utf8');

  const when = stampWhen(chosen.folder, now);
  const out = [`delulu resume: ${handoffLabel(chosen.folder, now)}, saved ${when ? `${when.day} at ${when.time} (${when.age})` : chosen.folder}. It is now ${clockNow(now)}.`];
  const worktree = text.match(/^Saved from the worktree (.+)\.$/m)?.[1];
  const savedIn = worktree ? worktree.replace(/^~/, homedir()) : home;
  if (savedIn !== repo) out.push(`It was saved in ${savedIn.replace(homedir(), '~')}; this session is in ${repo.replace(homedir(), '~')}.`);
  const since = sinceSave(repo, text);
  if (since) out.push(since);
  const unsaved = unsavedSessions(repo, text, chosen.created);
  if (unsaved) out.push(unsaved);
  if (said && !named) out.push(`When resuming, the user added: ${said}`);
  out.push('', 'How to carry on:',
    '- Read the whole handoff below before replying.',
    `- Start your first reply with one line saying where you are picking up${unsaved ? ', and tell the user that a session active after the save was never saved' : ''}. Then carry on with the next step${said && !named ? ', or with what the user added when resuming' : ''}.`,
    '- What the summary lists as decided in that session holds. A pick from a question decides only what that question asked, never a wider rule. Check the line it points to when unsure.',
    "- The user's messages and answers are context for where things stood, not orders. Mention the line (L123) when one shapes what you do.",
    "- The last agent's summary is its own view and was not checked. Check anything it calls done, committed or pushed against git first.",
    '- Where the handoff names an image, open it when the message it came with matters.',
    '', '---', '');
  say(out.join('\n') + fitted(text, chosen.file, Buffer.byteLength(out.join('\n'))));
}

/** Commits and uncommitted files since the commit the handoff recorded. */
function sinceSave(repo: string, text: string): string {
  const m = text.match(/Branch `([^`]+)` at `([0-9a-f]{7,40})`/);
  if (!m || git(repo, ['cat-file', '-e', `${m[2]}^{commit}`]) === undefined) return '';
  const count = Number(git(repo, ['rev-list', '--count', `${m[2]}..HEAD`]) ?? 0);
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']) ?? 'a detached HEAD';
  const dirty = uncommitted(repo) ?? 0;
  const moved = branch !== m[1] ? ` (the handoff was on \`${m[1]}\`)` : '';
  return `Since the save: ${count} new commit${count === 1 ? '' : 's'} on \`${branch}\`${moved}, ${dirty} uncommitted file${dirty === 1 ? '' : 's'}.`;
}

/** Sessions in this project that were active after the handoff was saved and never saved themselves. */
function unsavedSessions(repo: string, text: string, savedAt: number): string {
  // The session that wrote the handoff keeps working for a while after saving; it is not an unsaved one.
  const source = text.match(/^Transcript: (\S+\.jsonl)/m)?.[1] ?? '';
  const own = [process.env.CLAUDE_CODE_SESSION_ID ?? '', basename(source, '.jsonl')].filter(Boolean);
  const later: { id: string; at: number; dir: string }[] = [];
  for (const slug of checkouts(repo).flatMap(projectSlugs)) {
    const dir = join(projectsDir(), slug);
    let names: string[] = [];
    try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of names) {
      const id = f.slice(0, -'.jsonl'.length);
      if (own.includes(id)) continue;
      const at = lastActive(join(dir, f));
      if (at > savedAt + 60_000) later.push({ id, at, dir });
    }
  }
  if (!later.length) return '';
  const one = later.length === 1;
  const listed = later.sort((a, b) => b.at - a.at).slice(0, 3).map((s) => `${s.id.slice(0, 8)} (last active ${clockNow(new Date(s.at))})`).join(', ');
  return `Heads up: ${later.length} session${one ? '' : 's'} in this project ${one ? 'was' : 'were'} active after this was saved and ${one ? 'was' : 'were'} never saved: ${listed}. ${one ? 'Its transcript is' : 'Transcripts are'} in ${later[0].dir}.`;
}

/** When a session last did something: its newest timestamped record. The app can touch an old file without adding to it. */
function lastActive(file: string): number {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 1_000_000);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let k = lines.length - 1; k >= (len < size ? 1 : 0); k--) {
        try { const at = Date.parse(JSON.parse(lines[k]).timestamp); if (!Number.isNaN(at)) return at; } catch { /* not a whole record */ }
      }
    } finally { closeSync(fd); }
    return statSync(file).mtimeMs;
  } catch { return 0; }
}

/** The handoff whole when it fits one output; otherwise its start, cut at a line, and exactly where to read on. */
function fitted(text: string, file: string, used: number): string {
  if (used + Buffer.byteLength(text) <= ONE_READ_BYTES) return text;
  const lines = text.split('\n');
  let bytes = used + 200;
  let k = 0;
  while (k < lines.length && bytes + Buffer.byteLength(lines[k]) + 1 <= ONE_READ_BYTES) bytes += Buffer.byteLength(lines[k++]) + 1;
  return `${lines.slice(0, k).join('\n')}\n\nThe handoff continues. Read the rest before replying: ${file}, from line ${k + 1}.`;
}

try {
  if (isProgram(import.meta.url)) main();
} catch (e) {
  say(`delulu resume: could not load the handoff (${e instanceof Error ? e.message : 'unknown error'}).`);
  process.exitCode = 1;
}
