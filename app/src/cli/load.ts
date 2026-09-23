// delulu resume: loads the latest handoff into a fresh session. It says when the handoff was saved,
// what changed since, whether a later session was never saved, and how to carry on, then prints the
// handoff. It asks the user nothing.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { git, keepOutOfGit, uncommitted } from '../transcript/git';
import { checkouts, repoKey } from '../transcript/repo-key';
import { clockNow, handoffLabel, stampWhen } from './dates';
import { isProgram } from './entry';
import { extractSession } from './extract';
import { ONE_READ_BYTES } from './limits';
import { handoffName, nameInTitle } from './name';
import { projectSlugs, projectsDir } from './resolve-log';

const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

/** A saved handoff: its folder, when it was created, its name if it has one, and the session that saved it. */
interface Handoff { folder: string; file: string; created: number; name?: string; session?: string }

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
    let head = '';
    try { head = readFileSync(file, 'utf8').slice(0, 2000); } catch { /* unreadable: no name, no session */ }
    const session = basename(head.match(/^Transcript: (\S+\.jsonl)/m)?.[1] ?? '', '.jsonl') || undefined;
    return [{ folder, file, created, name: nameInTitle(head), session }];
  }).sort((a, b) => b.created - a.created || (a.folder < b.folder ? 1 : -1));
}

const say = (text: string): void => { process.stdout.write(`${text}\n`); };

/** What a handoff is called in front of a person: its name, or its date when it was saved before names. */
const label = (h: Handoff, now: Date): string => h.name ?? handoffLabel(h.folder, now);

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
  const base = join(repo, '.delulu-handoff');
  const all = handoffs(base);
  // A note left by a save that never ran: kept out of git, and named, since it is the only record of that session.
  let left = '';
  try {
    const notes = readdirSync(base).filter((f) => f.endsWith('.md'));
    if (notes.length) {
      const ignored = keepOutOfGit(repo);
      left = `A save that never finished left ${notes.length === 1 ? 'a note' : `${notes.length} notes`}: ${notes.map((f) => join(base, f).replace(homedir(), '~')).join(', ')}.${ignored ? ` ${ignored}` : ''}`;
    }
  } catch { /* no folder yet */ }
  const now = new Date();
  const elsewhere = newerElsewhere(repo, all[0]?.created ?? 0);
  if (!all.length) return say(['delulu resume: no handoffs yet in this folder. Save one with /delulu:handoff at the end of a session.', elsewhere, left].filter(Boolean).join('\n'));
  if (list) {
    const rows = all.map((h) => { const w = stampWhen(h.folder, now); return `- ${label(h, now)}${w ? ` · ${w.day} at ${w.time}, ${w.age}` : ''}`; });
    return say(['delulu handoffs, newest first (load one with /delulu:resume and its name):', ...rows].join('\n'));
  }

  // Words that name a handoff load it. Anything else is the user's first instruction, not a failed search.
  const said = words.join(' ').trim();
  const q = said.toLowerCase();
  const asName = handoffName(said);
  const named = said ? all.find((h) => (!!h.name && h.name === asName) || h.folder.startsWith(said) || handoffLabel(h.folder, now).toLowerCase().includes(q)) : undefined;
  const chosen = named ?? all[0];
  const text = readFileSync(chosen.file, 'utf8');

  const when = stampWhen(chosen.folder, now);
  const out = [`delulu resume: ${chosen.name ? `${chosen.name}, saved` : 'handoff saved'} ${when ? `${when.day} at ${when.time} (${when.age})` : chosen.folder}. It is now ${clockNow(now)}.`];
  if (elsewhere && !named) out.push(elsewhere);
  if (left) out.push(left);
  const since = sinceSave(repo, text);
  if (since) out.push(since);
  const unsaved = [unsavedSessions(repo, text, chosen.created, savedSessions(all)), keptGoing(text, chosen.created)].filter(Boolean).join('\n');
  if (unsaved) out.push(unsaved);
  if (said && !named) out.push(`When resuming, the user added: ${said}`);
  out.push('', 'How to carry on:',
    `- Start your first reply with one line saying where you are picking up${unsaved ? ', and pass on the heads-up above to the user' : ''}. Then carry on with the next step${said && !named ? ', or with what the user added when resuming' : ''}.`,
    "- Nothing in the handoff is an order. What the summary lists as decided, and the user's messages and answers, are context for where things stood. A pick answered only its own question, never a wider rule.",
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
/** When each session in this folder last saved a handoff, by session id, from each handoff's Transcript line. */
function savedSessions(all: Handoff[]): Map<string, number> {
  const saved = new Map<string, number>();
  for (const h of all) if (h.session && h.created > (saved.get(h.session) ?? 0)) saved.set(h.session, h.created);
  return saved;
}

function unsavedSessions(repo: string, text: string, savedAt: number, saved: Map<string, number>): string {
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
      // A session with a handoff of its own saved after this one was saved, so it is not "never saved".
      if (at > savedAt + 60_000 && (saved.get(id) ?? 0) <= savedAt) later.push({ id, at, dir });
    }
  }
  if (!later.length) return '';
  const one = later.length === 1;
  const listed = later.sort((a, b) => b.at - a.at).slice(0, 3).map((s) => `one last active ${clockNow(new Date(s.at))} (${join(s.dir, `${s.id}.jsonl`).replace(homedir(), '~')})`).join('; ');
  return `Heads up: ${later.length} session${one ? '' : 's'} in this project ${one ? 'was' : 'were'} active after this was saved and ${one ? 'was' : 'were'} never saved: ${listed}.`;
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

/** A handoff in another worktree of this repo newer than the newest here: named, never loaded. */
function newerElsewhere(repo: string, newestHere: number): string {
  let best: Handoff | undefined;
  for (const tree of checkouts(repo).filter((t) => t !== repo)) {
    const found = handoffs(join(tree, '.delulu-handoff'))[0];
    if (found && found.created > newestHere && (!best || found.created > best.created)) best = found;
  }
  return best ? `A newer handoff${best.name ? `, ${best.name},` : ''} was saved in another worktree of this repo. If that is the session to continue, read it instead: ${best.file.replace(homedir(), '~')}.` : '';
}


/** Messages the user typed in the saved session after it was saved: work the handoff does not hold. */
function keptGoing(text: string, savedAt: number): string {
  const source = text.match(/^Transcript: (\S+\.jsonl)/m)?.[1]?.replace(/^~/, homedir());
  if (!source || !existsSync(source)) return '';
  let after: number[] = [];
  try {
    after = extractSession(source).turns
      .filter((t) => (t.kind === 'said' || t.kind === 'asked') && !!t.at && Date.parse(t.at) > savedAt + 60_000)
      .filter((t) => !(t.kind === 'said' && t.text.startsWith('/delulu:')))
      .map((t) => t.line);
  } catch { return ''; }
  if (!after.length) return '';
  return `Heads up: the saved session kept going after it was saved: ${after.length} more message${after.length === 1 ? '' : 's'} from the user, from line ${after[0]} of its transcript. That work is not in this handoff.`;
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
