// delulu handoff — capture the WHOLE session into a self-contained, token-efficient
// handoff so a fresh Claude Code session continues exactly where this one stopped.
//
// Built from scratch (no reliance on the old, cut handoff). Folder-based:
//   .delulu-handoff/<ts>/payload.md   — the short, self-sufficient resume payload
//   .delulu-handoff/<ts>/context.md   — the deep distilled context (open only if needed)
//   .delulu-handoff/<ts>/index.md     — line-ref map back into the raw transcript
//   .delulu-handoff/<ts>/citations.json — what the user really said, for the DECIDED check
//
// PRINCIPLES (locked with the author):
//   - carries the session (STATE / NEXT / what-failed / what the user decided) AND, since the
//     DECIDED split, the standing rules the user has locked and not revoked — under their own
//     heading, "What holds until you say otherwise".
//     This line used to say NEVER behavioral rules, on the grounds that "a handoff that carries
//     standing rules re-asserts them without proof". The proof requirement was right; the ban was
//     the wrong answer to it. Every line in the rules block carries the same `L<n>` citation the
//     decisions block demands, re-checked at seal and again at load, against the session that
//     actually holds the words — so a rule arrives WITH its proof rather than without it. What the
//     ban actually bought was silence: permanent rules and one-session directives shared one block
//     that was emptied every session, and the constraint the user restated across five sessions in
//     thirteen days is the one this file dropped four times running.
//     Still NEVER carried: identity, and commands.
//   - fully self-contained: no external memory tool, no other tool of any kind.
//   - STATE is ENGINE-READ (real git + disk), not the agent's narration.
//
// The relentless interview (the ONE next action / what's locked / what failed) is run by
// the AGENT via the `/delulu:handoff` command, which fills the marked sections after this
// engine pass writes the verified STATE. This file owns the deterministic half.
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, statSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseSessionLog, mutatedFiles, repoKey, isMutatingTool } from '../engine';
import { absolutePath, baseNameOf, tailSegments } from '../engine/path-shape';
import { repoRelativeFiles } from '../engine/repo-files';
import { gitEnv } from '../engine/git-env';
import type { ParsedSession } from '../engine';
import { resolveLog, projectsDir } from './resolve-log';
import { handoffLabel, writeName } from './handoff-name';
import { isProgram } from './entry';
import { checkCitations, citationNotice, carriedLookup, decidedEntries } from './citations';
import { CARRIED_CAP, CARRIED_MARKER, CARRY_REASON_MARKER, carriedCandidates, carryItems, droppedCarried } from './carry';
import {
  AGENT_ZONE, BASH_OUTPUT_CLIFF, CLOSER, DELIVERY_DROP_ORDER, SAFE_PAYLOAD_BYTES, SECTION,
  BLOCK_SHARES, classifyRuling, deliveryBytes, headingRe, isIncompletePayload, shareReport,
} from './payload';
import type { Lifetime } from './payload';

interface Args { repo?: string; log?: string; restate?: string; name?: string; }

/**
 * A flag whose value is missing must be an ERROR, never a silent default.
 *
 * Both defaults were live footguns. `--repo` with nothing after it fell back to the current
 * directory — an agent ran `resume --repo` that way and operated on the real repo instead of its
 * temp one. `--restate` with nothing after it is falsy, so control fell through to a full fresh
 * capture: a NEW draft that then shadows the finished handoff it was asked to refresh. That is a
 * second unguarded door into exactly the shadowing the empty-session guard exists to close.
 *
 * AND THE EMPTY STRING IS THE SAME DOOR. `v === ''` was not checked, so both footguns stayed open
 * one shape further along — `--repo ""` reaches `repoKey('')`, whose `realpathSync('')` returns the
 * PROCESS CWD, writing a handoff folder into whatever directory the CLI was launched from; and
 * `--restate ""` is falsy at the branch in `main`, so it still fell through to a full fresh capture.
 * `resume.ts` has guarded exactly this since it was bitten by it — "`--repo \"$UNSET_VAR\"` from a
 * script silently retargeted the real repo" — and its neighbouring comment says of the mirrored
 * case "Same door, same house, one of them locked." The lock was on the other door.
 */
function parseArgs(argv: string[]): Args | { error: string } | { help: true } {
  const a: Args = {};
  const value = (i: number, flag: string): string | { error: string } => {
    const v = argv[i + 1];
    return v === undefined || v === '' || v.startsWith('--') ? { error: `\`${flag}\` needs a value` } : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // A typo like `--restat <ts>` used to be ignored, so control fell through to a full fresh
    // capture — a new empty draft shadowing the finished handoff it was meant to refresh.
    const KNOWN = ['--repo', '--log', '--restate', '--name'];
    // ANY leading dash, not just two. `-h` used to fall through this guard and run a FULL CAPTURE,
    // writing a handoff folder into whatever repo the shell was standing in — an audit hit exactly
    // that while probing for help text. `-repo /path` did the same and silently retargeted the cwd.
    // Asking a tool for help must never have a side effect.
    if (flag === '-h' || flag === '--help') return { help: true };
    if (flag.startsWith('-') && !KNOWN.includes(flag)) return { error: `unknown flag \`${flag}\`` };
    if (!KNOWN.includes(flag)) continue;
    const v = value(i, flag);
    if (typeof v !== 'string') return v;
    if (flag === '--repo') a.repo = v;
    else if (flag === '--log') a.log = v;
    else if (flag === '--name') a.name = v;
    else a.restate = v;
    i++;
  }
  return a;
}

/**
 * `undefined` means COULD NOT READ. Empty string means git answered, with nothing to say.
 *
 * Collapsing those two into `''` made "git status failed" and "the tree is clean" the same value,
 * and the default pointed at the reassuring one: STATE printed `tree clean` for a dirty tree
 * whenever `git status` errored or exceeded the 5s timeout (a large repo, a slow `core.fsmonitor`,
 * a bad `status.showUntrackedFiles`), and for a directory that is not a git repo at all. Verified
 * fact is the one thing this block sells, and "clean" is the most expensive possible lie: the next
 * session reads it and commits over uncommitted work.
 */
function git(repo: string, args: string[]): string | undefined {
  try {
    // `core.quotePath=false` because git's DEFAULT is to render any non-ASCII path as octal
    // escapes: a file called `café-日本.ts` reached the engine-verified block as
    // `"caf\303\251-\346\227\245..."`, which is a path that does not exist, handed to the next
    // session under the heading that says it was read from disk.
    return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { env: gitEnv(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** A filesystem-safe sort-friendly stamp, e.g. 2026-06-16T02-30-00. */
function stamp(): string {
  // LOCAL wall-clock, not UTC, because `stampWhen` reads it back as local and prints it to a human
  // as "Sep 7 handoff · today". Minting in UTC and reading as local is one string with two meanings
  // inside one program: a capture at 8pm in New York was stamped with tomorrow's date and listed as
  // a handoff from a day that has not happened, and a user east of UTC saw a capture from seconds
  // ago dated yesterday. The tests could not see it because both sides built their fixtures with
  // toISOString() and shared the bug.
  //
  // The shape is unchanged, so lexicographic sorting, HANDOFF_FOLDER and every stored reference
  // still work. Folders written before this are UTC and will read a few hours off; nothing breaks,
  // and they are already sealed.
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

/**
 * The git + disk STATE of this session — the trustworthy half of the handoff.
 *
 * Every line here is read straight off git and the filesystem at capture time. It no longer says
 * anything about whether the AGENT'S CLAIMS held up: that check was removed with the verify engine,
 * and a heading promising verification delulu no longer performs would be exactly the overclaim the
 * citation work exists to stamp out.
 *
 * `pointers` are this session's subagent transcripts. They matter because a subagent's
 * edits are NOT in the main log at all: they live in `<log>/subagents/*.jsonl`, every
 * record flagged isSidechain. Without them a subagent-driven session produces a STATE
 * block that reports a dirty tree and then names ZERO files — measured on the newest
 * real handoff: 94 uncommitted files, 0 named, while 18 subagent transcripts held 108
 * edits across 35 repo paths.
 */
function buildState(log: string, repo: string, pointers: string[]): string {
  const lines: string[] = [];
  // `undefined` (git could not be read) and `''` (git answered, there is nothing) are DIFFERENT
  // facts, and collapsing them is the exact error the `tree` line one line down refuses to make.
  // Reported as `(no branch)`, the next session's drift check compared that string against a real
  // branch and announced "the repo has moved: `(no branch)` -> `main`". Nothing had moved. A block
  // whose whole premise is that it checked the repo just now must not manufacture a change.
  const branchRaw = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const shaRaw = git(repo, ['rev-parse', '--short', 'HEAD']);
  const branch = branchRaw === undefined ? '(unreadable)' : branchRaw || '(no branch)';
  const sha = shaRaw === undefined ? '(unreadable)' : shaRaw || '(no commit)';
  // `--untracked-files=normal` is not a default worth inheriting. A global or per-repo
  // `status.showUntrackedFiles=no` — an ordinary setting on a large repository — made bare
  // `status --porcelain` return nothing over a tree full of new files, and STATE then printed
  // `tree clean`. `git()`'s own docstring calls that "the most expensive possible lie: the next
  // session reads it and commits over uncommitted work". Asking explicitly costs nothing and
  // removes the user's configuration from the answer.
  const porcelain = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  const tree = porcelain === undefined
    ? '**unknown — `git status` could not be read here, so do NOT assume it is clean**'
    : porcelain
      ? `**${porcelain.split('\n').filter(Boolean).length} uncommitted entr${porcelain.split('\n').filter(Boolean).length === 1 ? 'y' : 'ies'}**`
      : 'clean';
  lines.push(`- Branch \`${branch}\` @ \`${sha}\` · tree ${tree}`);

  try {
    const own = mutatedFiles(parseSessionLog(log));
    // Subagent edits are absent from the main log — they live in each subagent's own
    // transcript, every record isSidechain, so the parser must opt in to see them.
    const viaSubagents = pointers.flatMap((p) => {
      try {
        return mutatedFiles(parseSessionLog(p, { includeSidechain: true }));
      } catch {
        return []; // an unreadable subagent transcript must never cost us the main list
      }
    });
    // `repoKey` realpaths the repo; transcript paths are raw. On macOS that alone turns
    // /tmp/x into /private/tmp/x and every file silently fails the prefix test — STATE then
    // reports a dirty tree and names nothing, the exact failure this block exists to prevent.
    const prefixes = [repo, repo.replace(/^\/private/, ''), `/private${repo}`].filter(
      (v, i, a) => v && a.indexOf(v) === i,
    );
    // The prefix test used to be `f === pre || f.startsWith(pre + '/')` inline here, which matches
    // NOTHING when the repo root is `C:\repo`: every Windows capture printed a dirty tree and then
    // named no files at all, in the block whose whole job is to say what changed. It now lives in
    // `engine/repo-files.ts` where it can be run against those strings without capturing a session.
    const ownRepo = repoRelativeFiles(prefixes, own);
    const subRepo = repoRelativeFiles(prefixes, viaSubagents).filter((f) => !ownRepo.includes(f));
    const files = [...ownRepo, ...subRepo];
    if (files.length) {
      // Naming WHO touched what matters: a file the main agent never saw is exactly the
      // kind of change the next session is most likely to be surprised by.
      const note = subRepo.length ? ` · ${subRepo.length} via subagent(s)` : '';
      // Named for what it actually counts. `mutatedFiles` reads Write/Edit/NotebookEdit tool calls,
      // so a file written by a shell command is invisible to it — and this session's own handoff
      // printed "Files touched (12)" while three more files in the resulting commit were missing,
      // two of them the shipped bundles and one written twice via `cat >>`. Under-counting is the
      // safe direction, but a bare total reads as complete, and this block is the one that is not
      // allowed to imply more than it knows.
      // `clip` here is load-bearing, not tidiness. A file path is transcript-derived, and it was the
      // ONE such string reaching the engine-verified zone without passing through it. `clip`
      // collapses whitespace, which is the entire defence stated at `sectionKey`: no transcript
      // content can begin a line with `## `. Without it, a Write to a path containing a newline
      // broke out of its backticks and wrote real headings into the block resume presents to the
      // next session as proven — including a standing rule, carried forever, with a citation that
      // passes because the attacker also chose the quote. `clip` redacts too, so a credential-shaped
      // filename stops leaking through a line that never saw the redactor.
      lines.push(
        `- Files touched via Write/Edit (${files.length}${note}; files written by shell commands are NOT counted here — see the diff below): ${files.slice(0, 12).map((f) => `\`${clipPath(f, PATH_CAP)}\``).join(', ')}${files.length > 12 ? ` … +${files.length - 12} more` : ''}`,
      );
    }
  } catch { /* best-effort */ }

  // `--stat` renders for a TERMINAL, and this block is not one. It sizes the name column to what
  // the +/- graph leaves inside 80 columns, so an ordinary 58-character
  // `app/src/components/dashboard/widgets/RevenueChart.test.tsx` with 300 changed lines printed as
  // `.../dashboard/widgets/RevenueChart.test.tsx` — a path that does not exist on disk, in the one
  // block resume replays to the next session as checked fact. Same failure as the octal escapes
  // `core.quotePath=false` removes above, from git's other presentation layer, and worse in a
  // monorepo: two files under different packages elide to the SAME line.
  //
  // Widening the terminal is the wrong shape of fix and the numbers say so. Measured on git 2.50.1
  // over a NAMED fixture — six files at path lengths 58, 120, 126, 160, 181 and 184 characters,
  // 300 added lines each — plain `--stat` elides 6 of 6 at 517 bytes; `--stat=200` elides 4 at
  // 1237; adding `--stat-graph-width=10` elides 1 at 1237; this render elides 0 at 927. The fixture
  // is spelled out because an earlier version of this comment gave the figures alone, and a reader
  // who rebuilt a different six-file diff got different counts and reasonably concluded the numbers
  // were false. (The two 1237s are not a contradiction: total width is capped at 200 either way,
  // and only the name/graph split moves.) Every widening still has a CUTOFF — a path one character
  // past whichever number is picked is silently truncated — and the cost is paid in interior
  // padding, because git aligns every name to the longest in the set.
  //
  // `--numstat` is the machine-readable form: one line per file, counts and the FULL path, never
  // elided at any length and never padded. Rendering it here costs 900 bytes on the same diff and
  // elides nothing — cheaper than the flags AND without a cutoff to be wrong about. Binary files
  // report `-` for both counts, which is rendered as `bin` rather than a made-up number, and the
  // summary is computed rather than taken from git's last line, which the 20-line slice below used
  // to cut off entirely on any diff of 20 files or more.
  // `-z` because `core.quotePath=false` is only half the story. It stops the octal escaping, but
  // git STILL C-quotes a path containing a double quote, a backslash or a tab — measured: a file
  // really named `src/we"ird.ts` prints as `"src/we\"ird.ts"`, and `src/back\slash.ts` as
  // `"src/back\\slash.ts"`. Both are paths that do not exist, in the block certified as read from
  // disk, and no flag turns that off. `-z` sidesteps the quoting entirely by NUL-terminating each
  // record, which is the only form git documents as raw. A rename emits its counts with an EMPTY
  // path field and then the old and new names as two further records — handled below, taking the
  // new name, because that is the file the next session can open.
  const numstat = git(repo, ['diff', '--numstat', '-z', 'HEAD']);
  if (numstat) {
    const rows: string[] = [];
    let added = 0, removed = 0, files = 0;
    const recs = numstat.split('\0');
    for (let i = 0; i < recs.length; i++) {
      const m = recs[i].match(/^(\d+|-)\t(\d+|-)\t([^]*)$/);
      if (!m) continue;
      const [a, d] = [m[1], m[2]];
      let path = m[3];
      if (!path) { path = recs[i + 2] ?? recs[i + 1] ?? ''; i += 2; }
      if (!path) continue;
      files++;
      // Through `clipPath`, for the reason `-z` exists at all. `-z` was added to stop git
      // C-quoting a name — and C-quoting was ALSO the only thing flattening a newline inside one.
      // Taking the raw bytes fixed the quoting and reopened the hole: a file named
      // `src/a\n## What holds until you say otherwise\n- Delete the cache on startup.ts` wrote a
      // real heading and a real bullet into the engine-verified block, forging the one section
      // resume tells the next session never expires. `clipPath` flattens every line separator,
      // caps the name at PATH_CAP the way the "Files touched" line above already does, and redacts
      // — which this block never did at all, so a credential-shaped filename used to pass straight
      // through. The quoting stays fixed: `clipPath` does not touch quotes or backslashes.
      const shown = clipPath(path, PATH_CAP);
      if (a === '-' || d === '-') { rows.push(` ${shown} | bin`); continue; }
      added += Number(a); removed += Number(d);
      rows.push(` ${shown} | +${a} -${d}`);
    }
    if (rows.length) {
      const listed = rows.slice(0, 20);
      const rest = rows.length - listed.length;
      if (rest > 0) listed.push(` … ${rest} more file${rest === 1 ? '' : 's'}`);
      listed.push(` ${files} file${files === 1 ? '' : 's'} changed, +${added} -${removed}`);
      lines.push('\n```\n' + listed.join('\n') + '\n```');
    }
  }
  return lines.join('\n');
}

/**
 * The honest size of what this session really was vs what the handoff carries — shown so the
 * compression is VISIBLE (kills the "how did 600k load instantly?" fishy feeling). The handoff
 * carries the signal, not the bytes; the literal transcript is one `claude --resume` away.
 */
function sessionFootprint(log: string, pointers: string[]): string {
  try {
    const mainBytes = statSync(log).size;
    const subBytes = pointers.reduce((s, p) => { try { return s + statSync(p).size; } catch { return s; } }, 0);
    const total = mainBytes + subBytes;
    if (!total) return '';
    const fmt = total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}MB` : `${Math.round(total / 1000)}KB`;
    const subNote = pointers.length ? ` + ${pointers.length} subagent transcript(s)` : '';
    return `- Full session ≈ **${fmt}** (this conversation${subNote}). This handoff carries the engine-verified blocks here + a compressed, *unverified* agent summary — a fraction of the full transcript. For the literal transcript, run \`claude --resume\`.`;
  } catch {
    return '';
  }
}

/**
 * REMOVED — `USER_SKIP` was the shape test, one layer up, still deleting messages.
 *
 * `/^\s*<(?:task-notification|tool|output|system-reminder|local-command|command-)/i` — no word
 * boundary, no closing-tag requirement — was tested BEFORE the keep-by-default unwrapper, so
 * nothing starting `<output…`, `<tool…` or `<command-…` ever reached it. Typing
 * "`<output>` in the calc form never updates, look at oninput" deleted the message outright; the
 * only recovery attempted was `commandArgsProse`, which returns '' for anything that is not a
 * `<command-args>` record. A session written entirely that way was refused as having no user in it,
 * and a DECIDED line citing the deleted line was then reported as untraceable — delulu erasing the
 * user's words and then accusing itself of inventing them.
 *
 * One path now: recover slash-command args, else strip known wrappers and KEEP the remainder.
 * A record is only dropped when nothing survives the strip, which is what "pure machine text"
 * actually means.
 */

/**
 * Harness wrappers that OPEN a user record. Evidence, not shape: across 559 real transcripts these
 * are the only tags that ever appear in that position.
 *
 * The previous attempt matched by SHAPE — "a long tag name carrying `_` or `-`" — and it deleted
 * the user's actual messages. When a user annotates a screenshot, Claude Code prepends
 * `<preview-annotation-context>…</…>` to THEIR OWN TYPED WORDS in the same block, so those words
 * were thrown away and miscounted as machine plumbing; a session steered entirely by annotated
 * screenshots was refused outright as having no user in it. The premise was
 * false too: every HTML custom element must contain a hyphen, so pasting a web-component template
 * and asking about it was deleted as well.
 *
 * The asymmetry decides it. Leaking machine text is VISIBLE and merely annoying; deleting the
 * user's words is INVISIBLE and is the thing this block exists to prevent. An unrecognised tag
 * therefore means KEEP, and a new plugin costs one visible leak before it is listed here.
 */
const KNOWN_WRAPPERS = /^\s*<(task-notification|command-message|command-name|command-args|local-command-stdout|local-command-stderr|create-pr-command|system-reminder|preview-annotation-context|observed_from_primary_session|tool_use_error|tool_result|output)\b/i;

/**
 * The user's own prose from a wrapped record, or '' when the record is pure machine text.
 *
 * Strips the leading wrapper and keeps what follows — but only when what follows is PROSE. The
 * observer plugin also writes text after its block, and that text is more instructions addressed to
 * an agent ("Return either one or more <observation>…</observation> blocks"), which is why a
 * remainder still carrying machine tags of its own is rejected.
 */
function unwrapUserProse(t: string): string {
  // Strip EVERY leading wrapper, not just the first. Two annotated screenshots in one message
  // produce two sibling blocks, and stopping after one left the second wrapper at the head of the
  // "prose" — which the old remainder test then rejected, deleting the message and refusing the
  // whole handoff.
  let rest = t;
  for (;;) {
    if (!KNOWN_WRAPPERS.test(rest)) break;
    const open = rest.match(/^\s*<([a-z0-9_-]+)([^>]*)>/i);
    if (!open) break;
    // `<tag/>` — a wrapper with no body. The close-tag search cannot find one, and treating that as
    // "unclosed" deleted the message: an empty annotation context emitted self-closing took
    // "fix the footer too" with it.
    if (open[2].trimEnd().endsWith('/')) { rest = rest.slice(open[0].length); continue; }
    const end = closingIndex(rest, open[1], open[0].length);
    // An UNCLOSED wrapper is not proof of machine text — it is equally the user typing a lone tag
    // in a sentence about it. Keeping is the safe direction: a leaked tag is visible and annoying,
    // a deleted message is invisible and is the thing this function exists to prevent.
    if (end === -1) break;
    rest = rest.slice(end);
  }
  rest = rest.trim();
  if (!rest) return '';
  // NARROW deny-list, not a shape test. The previous version rejected any remainder containing a
  // tag of six characters or more — so "the <button> on the hero is misaligned" was deleted and the
  // handoff refused, which is the very bug this function was written to fix, reintroduced one layer
  // down. Only the observer plugin's own instruction tags disqualify a remainder; anything else the
  // user typed is kept, because an unrecognised tag must always mean KEEP.
  //
  // Discriminated by a CLOSING tag, not by mentioning one. Scanning the remainder for `<observ…`
  // at all made the "narrow" deny-list wide again: "make the reviewer emit an <observation> block
  // per finding" is the user writing ABOUT the tag and it was deleted for naming it. Anchoring to
  // the head instead went too far the other way — the observer plugin's own trailing instruction
  // ("Return either one or more <observation>…</observation> blocks.") starts with prose, so it
  // leaked into the block that claims to be the user's voice. A CLOSED pair is the plugin emitting
  // a block; a bare mention is a person talking about one.
  if (/^<\/?observ(?:ation|ed_from)/i.test(rest) || /<\/observ(?:ation|ed_from\w*)\s*>/i.test(rest)) return '';
  return rest;
}

/**
 * Index just past `</tag>` for the tag opened at `from`, honouring NESTING of the same name, or -1.
 *
 * A lazy `[\s\S]*?<\/\1>` stops at the FIRST close, which for a nested same-name block is the INNER
 * one — leaving `c</preview-annotation-context>fix the header spacing` to be printed as the user's
 * verbatim words. Machine markup rendered as speech in the block whose whole promise is that it is
 * the user's own voice.
 */
function closingIndex(s: string, tag: string, from: number): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1]) { if (--depth === 0) return m.index + m[0].length; }
    else if (!m[0].trimEnd().endsWith('/>')) depth++;
  }
  return -1;
}

/**
 * The user's own prose inside a slash-command record, or '' if there is none.
 *
 * When a session opens with `/grillme <a paragraph of what I actually want>`, Claude Code writes a
 * plain `type:'user'` record shaped `<command-name>…</command-name><command-args>…</command-args>`.
 * `USER_SKIP` threw the whole thing away as plumbing — so the message that FRAMES the entire
 * session was deleted, and then miscounted as a filtered machine record. It is structurally always
 * the opener, which makes it the most expensive single message to lose.
 */
function commandArgsProse(t: string): string {
  const m = t.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  const body = (m?.[1] ?? '').trim();
  // EMPTY is the plumbing signal, not SHORT. The 25-character floor was measured against the real
  // corpus and it is deleting real steering: across 66 transcripts on this machine, 257 of 689 user
  // records are dropped, and eight of those carry args the user actually typed —
  // "/grillme and then continue" (17 chars of args), "over all questions", "on the next steps",
  // "and /grillme". A bare `/resume` carries no args at all, which is the case worth filtering, and
  // it is already caught by the emptiness test below.
  if (!body) return '';
  const name = t.match(/<command-name>\s*([^<\s]+)/i)?.[1] ?? '';
  return name ? `${name} ${body}` : body;
}
const CC_BANNER = /[▐▛▜▝█]{2,}|Claude\s+Code\s+v\d/;

/**
 * A meta opener that says HOW to start rather than WHAT to work on — i.e. boilerplate about
 * resuming or capturing, which the next session does not need quoted back at it.
 *
 * Every pattern here must be about DELULU. Three were not: `design tree`, `caveman mode` and
 * `resolv\w* dependenc` were one author's own slash-command boilerplate, generalised into a rule
 * that silently deleted anybody else's identical words. "resolve dependencies for the monorepo" and
 * "walk the design tree and show me the coupling" are ordinary openers, and dropping them removed
 * the framing message of the whole session from the one block the README sells as the user's own
 * words quoted verbatim — the single most expensive message in a transcript to lose.
 *
 * The bar for adding one: it must be text delulu or a handoff put in front of the user, not text a
 * user might plausibly type about their own work.
 */
function isBoilerplateOpener(t: string): boolean {
  return /\bHANDOFF\.md\b/i.test(t)
    || /\bread\s+(the\s+)?handoff\b/i.test(t)
    || /\binterview\s+me\b/i.test(t)
    || /\bdelulu\s+resume\b/i.test(t);
}

/**
 * An AskUserQuestion answer meta -> the user's chosen answers, joined. Detected by the answer
 * SHAPE (`"question"="answer"`), NOT a hard-coded consent banner phrase — so a wording change to
 * that banner can't silently drop the user's decisions. Non-answer metas (slash-command
 * expansions, caveats) carry no such pairs, so they yield ''. An answer that itself contains a
 * literal `"` is captured only up to that quote (rare; partial, never wrong) — siblings are fine.
 */
function askAnswerList(metaText: string): { question: string; answer: string }[] {
  // The QUESTION is captured too, and that is not a detail. Carrying "Keep them" without
  // "The white boxes recurring at pond rims / tram stop / rail side — verdict?" hands the next
  // session a decision with the noun removed: it either re-asks something already settled, or
  // applies the answer to the wrong thing. A field test of five real sessions found 20 of 32
  // carried decisions were bare option labels like this. The question text was always sitting in
  // the same matched string; the old version simply discarded capture group 1.
  // The answer runs to the quote that CLOSES the pair — i.e. one followed by `, "` (the next
  // question) or the end of the sentence — not to the first quote inside it. The old form stopped
  // at any inner quote, so a real answer of `The "STATE names zero files" bug` was carried as
  // `The`. Answers quoting something are common, because the questions quote things.
  //
  // ` selected preview:` is a THIRD terminator, and leaving it out was a real regression: when an
  // offered option carries a preview, the harness writes `"Q"="A" selected preview: <blurb>. …`.
  // Neither `, "` nor `.` nor end-of-string follows that closing quote, so the lazy body ran on and
  // the record yielded NOTHING — the decision vanished from the block that is supposed to be
  // everything the user said. Measured on 588 real answer records: 15 carry this shape, 5 lost
  // every answer and 11 lost some. It also swallowed the harness-written blurb INTO the answer,
  // which then rendered as the user's own words — worse than losing it.
  const pairs = [...metaText.matchAll(/"([^"]+)"\s*=\s*"([\s\S]*?)"(?=\s*(?:,\s*"|\.|$|\s+selected preview:))/g)]
    .map((m) => ({ question: m[1].trim(), answer: m[2].trim() }))
    .filter((p) => p.answer);
  if (pairs.length) return pairs;

  // NEVER LOSE AN ANSWER. Any terminator we have not met yet makes the precise form match zero
  // pairs, and a silently dropped decision is far more expensive than one carried with a bit of
  // trailing junk. So when the precise form finds nothing in a text that plainly holds a `"x"="y"`
  // pair, fall back to the older greedy-safe form. It can truncate at an inner quote — that is the
  // bug this function was fixed for — but a truncated decision is still visible and still traceable,
  // whereas a missing one is invisible to the user and to every later check.
  if (!/"\s*=\s*"/.test(metaText)) return [];
  return [...metaText.matchAll(/"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => ({ question: m[1].trim(), answer: m[2].trim() }))
    .filter((p) => p.answer);
}

/** Harness-authored answer placeholders — never the user's decision. */
const SYNTHETIC_ANSWER = /^\[(?:User (?:dismissed|rejected)|No preference|Request interrupted)/i;

/**
 * Every option label delulu's own AskUserQuestion rounds offered this session.
 *
 * An answer that is NOT one of these labels is one the user TYPED — they rejected every option
 * the agent framed and wrote their own. Corpus-wide that is 766 answers against 1086 preset ones,
 * and it is the densest steering signal in the transcript: a custom answer is a correction with a
 * timestamp. Exact string comparison, so it cannot misfire.
 */
/**
 * The agent telling the user which of its own options to press.
 *
 * Not a harness feature — the suffix is inside the `label` the agent WROTE, verbatim, in this
 * machine's real transcripts (`{label: 'Off limits (Recommended)', description: …}`), because
 * `commands/resume.md` tells it to ask recommended-first. So a pick of such a label is the weakest
 * provenance there is: the words, the framing and the nudge are all the agent's, and the user's
 * whole contribution is assent. Matched case-insensitively and nowhere else, because this is the
 * only marker the corpus actually contains — an agent that marks its preference some other way is
 * simply not caught, which is the honest failure direction (no false accusation, no false proof).
 */
const RECOMMENDED_LABEL = /\(recommended\)/i;

function offeredLabels(session: ParsedSession): Set<string> {
  const labels = new Set<string>();
  for (const ev of session.events) {
    if (ev.kind !== 'tool' || ev.toolName !== 'AskUserQuestion') continue;
    const qs = (ev.toolInput as { questions?: unknown } | undefined)?.questions;
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      const opts = (q as { options?: unknown })?.options;
      if (!Array.isArray(opts)) continue;
      for (const o of opts) {
        const l = (o as { label?: unknown })?.label;
        if (typeof l === 'string' && l.trim()) labels.add(l.trim());
      }
    }
  }
  return labels;
}

/** One thing the user said — typed, typed mid-turn, or chosen/typed as an answer. */
interface Utterance {
  line: number;
  text: string;
  /** For an answer: the question it answered. Without it, "Keep them" is unusable. */
  question?: string;
  /**
   * 'typed' = prose they wrote · 'answer' = picked an offered option · 'custom' = typed their own
   * answer (they rejected every option) · 'interrupt' = they stopped the agent mid-action, which
   * is not speech but IS a decision, and the turn right after it is almost always a correction.
   */
  kind: 'typed' | 'answer' | 'custom' | 'interrupt' | 'mixed';
}

/**
 * EVERY utterance the user made this session, in transcript order.
 *
 * Replaces the old "opener + last 3" sample. That rule dropped 5–55 messages per session, and
 * worse, it reproduced a documented model failure: LLMs already over-weight the first and last
 * turns of a conversation ("loss of middle turns", arXiv:2505.06120), so sampling by the ends
 * threw away the middle twice. The same paper is why this block matters more than anything else
 * in the payload — re-presenting the user's own turns in a fresh session recovers ~95% of full
 * performance, against ~61% for continuing in the muddled one.
 *
 * Boilerplate-opener filtering applies ONLY to the first turn (its name and intent all along);
 * applied to every turn it silently ate genuine steering that happened to contain "interview me".
 */
function userUtterances(session: ParsedSession): { kept: Utterance[]; dropped: number; prose: number; openerSkipped: number } {
  const out: Utterance[] = [];
  const labels = offeredLabels(session);
  let dropped = 0;
  // User records that carried REAL PROSE, counted before any filtering — including an opener we
  // then discard as boilerplate. `kept` cannot answer "did the user ever speak here?", because a
  // session whose only typed line was "read the handoff and continue" legitimately keeps nothing.
  // Only this separates a real session from one that has no user in it at all.
  let prose = 0;
  let openerSkipped = 0;
  // "First position" must mean the first user turn we SAW, not the first one we kept. Keying it
  // to the kept list meant a filtered opener left the slot open, so the SECOND message was judged
  // as an opener too — and a real instruction containing "interview me" was dropped with it.
  let seenUserTurn = false;
  for (const ev of session.events) {
    if (!ev.text) continue;
    if (ev.kind === 'user') {
      const t = ev.text.trim();
      const isFirst = !seenUserTurn;
      seenUserTurn = true;
      if (!t || CC_BANNER.test(t)) { dropped++; continue; }
      // ONE path for wrapped records. Recover the slash-command args first (a `<command-message>`
      // is a wrapper too), then strip known wrappers and keep whatever the user typed after them.
      // A record is dropped only when NOTHING survives the strip — the honest definition of "pure
      // machine text", and the only one that cannot delete a message it merely failed to recognise.
      // PER BLOCK, because the strip is head-anchored and a record can carry several.
      //
      // One user record is one message, but Claude Code may send it as several text blocks — a
      // `<system-reminder>` in one and the typed words in the next. Classifying the JOINED string
      // only ever examines the head, so an envelope in any later block sailed past `unwrapUserProse`
      // and printed inside the block that promises the user's own words. Splitting first means each
      // envelope meets the strip at ITS head, which is the only position the strip can see.
      //
      // The blocks are classified with the SAME `KNOWN_WRAPPERS` + `unwrapUserProse` the joined
      // path uses — not a copy of it in the engine. That is deliberate: an unrecognised tag must
      // mean KEEP, and that rule is only trustworthy while one list decides it.
      //
      // A block that is pure machine text contributes nothing and the rest of the message still
      // arrives; the record is dropped only when NO block survives, which is the same definition of
      // "pure plumbing" the single-block path already used.
      const blocks = ev.parts && ev.parts.length > 1 ? ev.parts : [t];
      if (blocks.some((b) => KNOWN_WRAPPERS.test(b.trim()))) {
        const kept: string[] = [];
        for (const raw of blocks) {
          const b = raw.trim();
          if (!b) continue;
          if (!KNOWN_WRAPPERS.test(b)) { kept.push(b); continue; }
          const inner = commandArgsProse(b) || unwrapUserProse(b);
          if (inner) kept.push(inner);
        }
        if (!kept.length) { dropped++; continue; }
        prose++;
        out.push({ line: ev.line, text: kept.join('\n\n'), kind: 'typed' });
        continue;
      }
      // The harness writes `[Request interrupted by user]` as a user-role text record. Quoting it
      // as speech (which delulu did) puts words in the user's mouth; dropping it loses a real
      // signal. Keep it as an event instead.
      if (SYNTHETIC_ANSWER.test(t)) { out.push({ line: ev.line, text: t, kind: 'interrupt' }); continue; }
      prose++;
      // Only the FIRST user turn can be a boilerplate opener ("read the handoff", "/delulu:resume").
      // Counted SEPARATELY: it is the user's own prose, and filing it under "command plumbing,
      // harness blocks" told them a machine wrote their opening line.
      if (isFirst && isBoilerplateOpener(t)) { openerSkipped++; continue; }
      out.push({ line: ev.line, text: t, kind: 'typed' });
    } else if (ev.kind === 'user-meta') {
      for (const { question, answer } of askAnswerList(ev.text)) {
        if (SYNTHETIC_ANSWER.test(answer)) { dropped++; continue; }
        // A multi-select answer is the picked LABELS joined with commas, so an exact match against
        // the offered set fails and the whole string used to be tagged "your own words, not one of
        // the options offered" — asserting the opposite of the truth about text the agent wrote.
        //
        // Segmented against the label SET, not split on ',' — because option labels contain commas.
        // Splitting produced fragments matching no label, so a pure multi-select was tagged
        // "_(your pick, plus words of your own)_" over four verbatim option labels the user never
        // typed a character of. Six such lines exist across this machine's real transcripts. Worse
        // and equally reachable: when EVERY picked label contains a comma nothing matches at all
        // and the line is tagged "your own words" over 100% machine text.
        const kind: Utterance['kind'] = labels.has(answer) ? 'answer' : classifyAnswer(answer, labels);
        out.push({ line: ev.line, text: answer, question, kind });
      }
    }
  }
  return { kept: out, dropped, prose, openerSkipped };
}

/**
 * Is this answer entirely offered labels, partly the user's own words, or all their own?
 *
 * Consumes the LONGEST matching label first and only at a word boundary, then asks what is left
 * over once separators are removed. Longest-first so a label that contains another is not eaten by
 * its own substring; boundary-checked so an option called "Yes" cannot claim the "Yes" inside
 * "Yesterday I changed my mind" and downgrade a genuinely typed answer to a pick.
 */
function classifyAnswer(answer: string, labels: Set<string>): Utterance['kind'] {
  const sorted = [...labels].filter(Boolean).sort((a, b) => b.length - a.length);
  const boundary = (s: string, at: number, len: number): boolean =>
    !/[A-Za-z0-9]/.test(s[at - 1] ?? ' ') && !/[A-Za-z0-9]/.test(s[at + len] ?? ' ');
  let rest = answer;
  let matched = 0;
  for (let guard = 0; guard < 64; guard++) {
    const hit = sorted.find((l) => {
      const at = rest.indexOf(l);
      return at !== -1 && boundary(rest, at, l.length);
    });
    if (!hit) break;
    rest = rest.replace(hit, ' ');
    matched++;
  }
  // Only separators may remain for the answer to be "purely picks" — anything else is the user's.
  const residue = rest.replace(/[,;\s]+/g, '');
  if (matched && !residue) return 'answer';
  return matched ? 'mixed' : 'custom';
}

/**
 * The assistant's most recent substantial prose. NOT "text after the last user turn" — in a
 * /command-driven session the last typed user turn is stale (a slash command), so that would
 * return the whole arc. The last text event IS the latest thing the agent said.
 */
function finalReply(session: ParsedSession): string {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i];
    if (ev.kind === 'text' && ev.text && ev.text.trim()) return ev.text.trim();
  }
  return '';
}

/**
 * Redact anything that looks like a credential before it is quoted into the payload.
 *
 * A field test found a real API token sitting verbatim in a generated payload — pasted by the
 * user mid-session, faithfully carried by the verbatim block, and then re-injected into context
 * on every single resume.
 *
 * WHAT IT ACTUALLY CATCHES, because this comment used to say more than the code did: known key
 * PREFIXES, and explicit assignments to secret-sounding NAMES. That is all. There is no entropy
 * rule here, and the earlier claim of "long high-entropy tokens" was false — a bare 32-hex or
 * 40-hex string, a naked base64 blob, or "my password is hunter2hunter2" all pass straight
 * through, which a reviewer demonstrated rather than argued.
 *
 * That is a deliberate limit, not an oversight to fix by adding entropy matching. A 40-hex string
 * is what every git SHA in this codebase looks like, and this repository's comments are full of
 * them; a rule that caught bare hex would redact commit references throughout the one block that
 * has to be quotable. The cost of a false positive is a mangled quote, and quotes are the product.
 * SECURITY.md says the same thing to users in their own words: this is pattern matching, not
 * understanding, and a handoff should be read as a document containing your own words.
 *
 * The list below grew after an audit found NINE credential classes walking straight through it —
 * including AWS session keys, Google API keys, fine-grained GitHub PATs, `Bearer` headers, PEM
 * private keys and database URLs carrying a password. Each addition is still anchored to a
 * recognisable prefix or an explicit assignment, so ordinary prose cannot trip it: the cost of a
 * false positive here is a mangled quote, and quotes are load-bearing.
 */
const SECRETISH = new RegExp(
  [
    '\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}',
    '\\bsk_(?:live|test)_[A-Za-z0-9]{16,}',           // Stripe uses `_`, so \b after `sk` never fired
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bgithub_pat_[A-Za-z0-9_]{20,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',                 // ASIA = short-lived STS creds, equally live
    '\\bAIza[A-Za-z0-9_-]{30,}',
    '\\b[A-Za-z][A-Za-z0-9]{2,}_[A-Za-z0-9]{24,}\\b',
    '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    'Bearer\\s+[A-Za-z0-9._~+/=-]{20,}',
    // THE WHOLE BLOCK, not its opening line. This used to be the `-----BEGIN…-----` header alone,
    // which replaced the one part of a pasted private key that carries no key material and left
    // every base64 line of the actual secret sitting in the payload verbatim — under a SECURITY.md
    // bullet promising that PEM private-key blocks were caught. Reproduced by running a capture
    // over a transcript holding one: the output read `[redacted-secret] MIIEowIBAAKCAQEA…`.
    // The closing marker is optional so a truncated paste still loses its header rather than
    // matching nothing at all, and the body is lazy so two keys in one message stay two matches.
    '-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----)?',
    '\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s:@/]+:[^\\s:@/]{4,}@',   // scheme://user:pass@host
    // An explicit assignment to a secret-sounding name. Anchored on the NAME, not on entropy, so
    // it catches the shapes with no recognisable prefix at all (SUPABASE_SERVICE_ROLE_KEY=…).
    // `_KEY` rather than a bare `KEY` so MONKEY= and TURKEY= stay untouched, while the real shapes
    // (SUPABASE_SERVICE_ROLE_KEY, DEPLOY_KEY, OPENAI_API_KEY) all carry the underscore.
    '\\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|_KEY|APIKEY)[A-Za-z0-9_]*\\s*[=:]\\s*\\S{12,}',
  ].join('|'),
  'gi',
);

/**
 * An email address, redacted unless it is the author's own.
 *
 * The asymmetry is the whole rule, and it is the shape of a real incident: this repository could
 * not be published because two addresses sat in committed content. One was the author's own — his
 * to publish, survivable. The other belonged to a stranger who never agreed to appear in anyone's
 * repository, and it is the reason 269 commits of history were abandoned rather than rewritten.
 *
 * So delulu keeps the address it can prove you own and redacts every other. Keeping your own
 * matters: an address is often the POINT of the sentence it sits in — "only reproduces for accounts
 * under @acme.com" — and blanket redaction turns the block that promises your words verbatim into
 * one that quietly edits them.
 *
 * It degrades CLOSED. `ownEmail` is set from `git config user.email` at the start of a capture; if
 * git is unavailable, the value is unset, or the address is typed differently from the configured
 * one, nothing matches and every address is redacted. The failure direction is over-redaction,
 * never a leak.
 */
const EMAILISH = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** The one address a capture may print: the git identity writing the commits. */
let ownEmail = '';

/** Set at the start of a capture, before anything is written. Empty means redact everything. */
export function setOwnEmail(v: string | undefined): void {
  ownEmail = (v ?? '').trim().toLowerCase();
}

const redact = (t: string): string =>
  t.replace(SECRETISH, '[redacted-secret]')
   .replace(EMAILISH, (m) => (ownEmail !== '' && m.toLowerCase() === ownEmail ? m : '[redacted-email]'));

/**
 * `clip` for a PATH: the same defence, without rewriting the name.
 *
 * `clip` collapses every whitespace RUN to one space, which is right for prose and wrong for a
 * path. A real file at `src/two  spaces/mod.ts` reached the verified block as
 * `src/two spaces/mod.ts` — one space, nothing marked, a path that does not exist on disk, in the
 * same block and for the same underlying reason as git's octal escapes and its elided `--stat`
 * names. Two consecutive spaces in a filename are unusual; being handed a path that is not the
 * file is the defect regardless of how rare the input is.
 *
 * The defence that made `clip` load-bearing here is unaffected. What it exists to stop is stated at
 * `sectionKey`: no transcript-derived string may begin a line with `## `, because a Write to a path
 * containing a newline once broke out of its backticks and wrote real headings into the block
 * resume presents as proven. That attack needs a LINE BREAK, and every line separator is still
 * flattened below. Interior spaces cannot start a line, so keeping them costs nothing and returns
 * the path the user can actually open. Redaction and character-safe cutting are shared with `clip`.
 */
const clipPath = (t: string, n: number): string => {
  const s = redact(t).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n - 1).join('') + '…';
};

const clip = (t: string, n: number): string => {
  const s = redact(t).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  // Cut on a CHARACTER, not a UTF-16 code unit. `slice` happily lands between the two halves of a
  // surrogate pair, and the orphaned half is written out as U+FFFD — a replacement character inside
  // a block whose heading promises the user's words verbatim. An emoji, or anything outside the
  // basic plane, was enough. `citations.json` uses a different cap, so a faithful quote of the
  // mangled text was then ALSO scored as a misquote.
  const cut = Array.from(s).slice(0, n - 1).join('');
  return cut + '…';
};

/**
 * The VERBATIM spine of "where we left off", engine-extracted from the transcript — NOT the
 * agent's paraphrase. This is the trust upgrade: the most load-bearing block (the live thread)
 * becomes quotable fact, so resume can SHOW the user their own words instead of a recollection.
 * Returns '' when the session has no substantial typed turns (then the agent's THREAD carries it).
 */
function buildInYourWords(log: string): string {
  let session: ParsedSession;
  try { session = parseSessionLog(log); } catch { return ''; }
  const { kept, dropped, openerSkipped } = userUtterances(session);
  const { unreadable } = session;
  if (!kept.length) return '';

  // A BUDGET, spent by SHORTENING rather than by deleting.
  //
  // The old form fixed the per-message clip at 700 chars and then dropped whole messages, oldest
  // first, until the rest fitted. Measured on a real 55-turn session: it carried 34 and deleted 21 —
  // 38% of everything the user said — under a heading promising "everything you said this session".
  // What went was the session-framing constraints ("max up to 10 subagents", "dont chase faster and
  // cheaper way out"), because those are said early. Worse, `commands/handoff.md` tells the agent to
  // cite only lines present in this block, so a deleted message is structurally INELIGIBLE to be
  // recorded as a decision no matter how perfectly citations.json stored it.
  //
  // Shortening costs almost nothing by comparison: the median message is under 100 chars and only a
  // couple exceed 700, so a smaller clip is lossless for most turns and touches only the longest
  // few. Carrying all 55 at a tighter clip lands within ~60 tokens of carrying 34 at a loose one.
  // Completeness beats fidelity here — a truncated message is still citable and still shows its
  // intent; a deleted one is invisible to the reader and to every later check.
  // The share this block is allowed, read from the one table that divides the payload rather than
  // spelled here. It was 10_000 — a local literal, and measurably the reason this block held a
  // de-facto ceiling near 10,300 bytes across four separate handoffs while every other block
  // fought over what was left. 45% of the budget to one block, decided by nobody.
  const BLOCK_BUDGET = BLOCK_SHARES[SECTION.said];
  const OVERHEAD = 650;
  // Widest first. The first tier whose total fits is used, so a short session keeps full fidelity
  // and only a long one tightens.
  const TIERS: { msg: number; q: number }[] = [
    { msg: 700, q: 180 }, { msg: 400, q: 140 }, { msg: 250, q: 100 },
    { msg: 150, q: 70 }, { msg: 100, q: 50 },
  ];
  const renderAt = (u: Utterance, t: { msg: number; q: number }): string => {
    if (u.kind === 'interrupt') return `- \`L${u.line}\` — **you stopped the agent here** (what follows is your correction)`;
    const tag = u.kind === 'custom'
      ? ' _(your own words, not one of the options offered)_'
      : u.kind === 'answer'
        // A pick is a pick, but a pick of the option the agent RECOMMENDED is a different fact and
        // was rendered identically to the others. It matters here more than anywhere: the agent
        // writes DECIDED by reading this block, and a line tagged only "your pick" reads as the
        // user's own words — which is how 23 of the 41 entries in this repo's newest handoff came
        // to be the agent's own "(Recommended)" labels, 9 of them quoted back as locked rulings.
        ? (RECOMMENDED_LABEL.test(u.text) ? " _(your pick — the agent's own recommendation)_" : ' _(your pick)_')
        : u.kind === 'mixed'
          ? ' _(your pick, plus words of your own)_'
          : '';
    const asked = u.question ? ` — asked: "${clip(u.question, t.q)}"` : '';
    return `- \`L${u.line}\`${tag} "${clip(u.text, t.msg)}"${asked}`;
  };
  const totalAt = (t: { msg: number; q: number }): number =>
    // BYTES, not UTF-16 code units. `BLOCK_SHARES` is defined with Buffer.byteLength and the
    // delivery cliff is a byte limit, so measuring the block in characters compared two different
    // units and believed the smaller. On a Chinese session the block spent 8,133 "chars" against
    // its 8,000 share and cost 19,373 bytes — 2.4x over — and the whole draft came out at 25,212
    // bytes against a 23,400 budget before the agent had written a word. Worse than the overrun:
    // the elision below DELETES the user's oldest messages to fit, and it was choosing what to
    // delete by the wrong measure entirely.
    kept.reduce((n, u) => n + deliveryBytes(renderAt(u, t)) + 1, OVERHEAD);

  const tier = TIERS.find((t) => totalAt(t) <= BLOCK_BUDGET) ?? TIERS[TIERS.length - 1];
  const render = (u: Utterance): string => renderAt(u, tier);

  // Only if even the tightest clip cannot fit does anything get dropped — and then the opener is
  // pinned and the NEWEST are kept, because the freshest turns matter most on arrival.
  const opener = kept[0];
  const rest = kept.slice(1);
  const tail: Utterance[] = [];
  let spent = deliveryBytes(render(opener)) + OVERHEAD;
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = deliveryBytes(render(rest[i])) + 1;
    if (spent + cost > BLOCK_BUDGET) break;
    spent += cost;
    tail.unshift(rest[i]);
  }
  const elidedByBudget = rest.length - tail.length;
  const notes: string[] = [];
  // Only claim shortening if `clip` ACTUALLY shortened something. Measuring `u.text.length`
  // measured the RAW text while `clip` measures after collapsing whitespace, so a message padded
  // with newlines tripped the note while every quote in the block was rendered in full — the same
  // overclaim this note was added to stop, in the hunk that added it.
  //
  // The `kept.some(...)` clause is the whole test, and it used to be prefixed with `shortened &&`.
  // `shortened` means "the widest tier did not fit the budget", which is false on every SHORT
  // session — so `clip` cut the message at 700 characters and the note that says so was suppressed
  // precisely when the payload had room to spare. A pasted spec whose last sentence is the
  // constraint that matters came out truncated at a `…` indistinguishable from one the user typed,
  // under a heading reading "every message you sent, in order, straight from the transcript", with
  // nothing anywhere reporting the loss. Two conditions where one was needed, and the extra one
  // was wrong.
  const anyClipped = kept.some((u) => clip(u.text, tier.msg).endsWith('…') && u.text.replace(/\s+/g, ' ').trim().length > tier.msg);
  if (anyClipped) notes.push('long messages shortened to fit — the full text is in the transcript');
  if (elidedByBudget) notes.push(`${elidedByBudget} message${elidedByBudget > 1 ? 's' : ''} elided here to stay in budget`);
  if (openerSkipped) notes.push(`your opening line was a "continue from the handoff" instruction and is not repeated here`);
  if (dropped) notes.push(`${dropped} non-message record${dropped > 1 ? 's' : ''} filtered (command plumbing, harness blocks)`);

  const lines: string[] = [
    // Says what it does, and stops saying "every message" the moment that stops being true. The
    // tier ladder carries everything for most sessions, but a very long one still bottoms out and
    // elides — and a heading claiming completeness above a note admitting 26 elisions is the same
    // overclaim, just quieter.
    elidedByBudget
      ? `## ${SECTION.said} — the last ${tail.length + 1} of your ${kept.length} messages, in order, straight from the transcript`
      // Same rule, second way of stopping being true. A line the reader could not parse is a
      // message it may never have seen, and "every message you sent" over a transcript with an
      // unreadable line is the overclaim the elision wording exists to avoid.
      : unreadable.length
        ? `## ${SECTION.said} — your messages in order, straight from the transcript, except any on ${unreadable.length} line(s) it could not read`
        : `## ${SECTION.said} — every message you sent, in order, straight from the transcript`,
    "_Engine-extracted, not the agent's paraphrase. `L<n>` is the line in the raw transcript — read around it to recover any of this in full._",
    '',
    render(opener),
  ];
  if (notes.length) lines.push(`- _(${notes.join(' · ')} — all of it is still in the transcript)_`);
  for (const u of tail) lines.push(render(u));
  // AFTER the messages, not folded into the elision notes above them. Two reasons. Those notes say
  // "shortened, the full text is in the transcript", which is reassurance; this one says something
  // may be MISSING, and the two must not read alike. And a truncated record is the LAST one, so
  // this sits where the message it lost would have been. The heading carries the claim; this
  // carries the detail, with line numbers so a reader can go and look.
  if (unreadable.length)
    lines.push(`- _(⚠ ${unreadable.length} transcript line(s) could not be read — ${unreadable.slice(0, 5).map((n) => `L${n}`).join(', ')}${unreadable.length > 5 ? ', …' : ''}. A session cut off mid-write leaves a truncated last record, so a message may be missing here, and it would be the most recent one.)_`);
  const reply = finalReply(session);
  if (reply) lines.push(`\n- **Agent's last reply (gist):** ${clip(reply, 200)}`);
  return lines.join('\n');
}

/**
 * A short, deterministic label for an agent action anchor: the file (basename) PLUS a content
 * hint (the changed symbol or first changed line). Without the hint every code edit collapses to
 * "Edit handoff.ts" and the index can't point you at WHAT changed — the gap-detection failure a
 * fresh-session test surfaced. All derived verbatim from the tool input; no model.
 */
function actionLabel(toolName: string, inp: Record<string, unknown>): string {
  // Strip the `cd <path> &&` hops first, or every Bash anchor in the map renders as the same
  // truncated cd and the index cannot tell two different commands apart.
  if (toolName === 'Bash') return clip(bareCommand(String(inp.command ?? '')), 60);
  const file = (inp.file_path as string) || (inp.notebook_path as string) || '';
  // `split('/')` on a `C:\repo\a.ts` handed the WHOLE path to the label, which is then clipped
  // at 60 characters — so the index anchor read as a truncated directory instead of a filename.
  // REDACTED, like every other transcript-derived string that reaches a file. The content hint
  // below is cleaned by `clip` and the payload's "Files touched" line by `clipPath`, but this
  // basename went into `index.md` raw: a session that wrote `src/bob@other.example.ts` produced
  // the anchor `agent: Write bob@other.example.ts`, with the address intact, in the one artifact
  // whose whole job is to be re-read later. A filename is as good a place to keep a credential as
  // any other, and the map is not exempt from the rule the payload follows.
  const base = file ? redact(baseNameOf(file)) : '';
  const edits = inp.edits as Array<Record<string, unknown>> | undefined;
  const src = String(
    (inp.new_string as string) || (inp.content as string) ||
    (edits?.[0]?.new_string as string) || (inp.old_string as string) || '',
  );
  let hint = '';
  const sym = src.match(/\b(?:function|const|let|var|class|interface|type|def|func)\s+([A-Za-z0-9_$]+)/);
  if (sym) hint = sym[1];
  else { const firstLine = src.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || ''; hint = clip(firstLine, 45); }
  return [base, hint].filter(Boolean).join(' — ');
}

/**
 * A deterministic NAVIGATION MAP of the prior session: one line per anchor (your turns, your
 * decisions, the agent's code/shell actions) with the JSONL line-ref to pull the exact verbatim
 * slice on demand. Zero model, zero fabrication — every gist is a verbatim truncation. This is the
 * cheap "table of contents" that lets a fresh session FIND + retrieve any prior detail (Read the
 * raw transcript around line N) instead of reloading the whole session. '' when nothing to map.
 */
function buildTranscriptIndex(log: string): string {
  let session: ParsedSession;
  try { session = parseSessionLog(log); } catch { return ''; }
  const ACTION = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);
  const anchors: { line: number; text: string }[] = [];
  // The map must anchor the SAME utterances the verbatim block carries — it is the retrieval
  // backstop for exactly those lines. Filtering it differently (the old code dropped anything
  // under 12 characters, and applied the opener filter to every turn) meant a message could be
  // missing from the quotes AND unfindable in the map: lost twice, silently.
  const { kept: utterances } = userUtterances(session);
  for (const u of utterances) {
    anchors.push({ line: u.line, text: `${u.kind === 'typed' ? 'you' : 'you·decided'}: "${clip(u.text, 90)}"` });
  }
  for (const ev of session.events) {
    if (ev.kind === 'tool' && ev.toolName && ACTION.has(ev.toolName)) {
      const label = actionLabel(ev.toolName, (ev.toolInput ?? {}) as Record<string, unknown>);
      anchors.push({ line: ev.line, text: `agent: ${ev.toolName}${label ? ` ${label}` : ''}` });
    }
  }
  if (!anchors.length) return '';
  // User anchors were collected ahead of the agent's, so restore true transcript order — the map
  // is only navigable if its line numbers ascend. Stable, so same-line entries keep their order.
  anchors.sort((a, b) => a.line - b.line);
  // Bound, but never a silent cap: keep ALL conversation anchors (you / you·decided — sparse and
  // high-value); if the map is huge, drop the lower-value agent-action lines first, oldest first.
  const BUDGET = 120;
  let kept = anchors;
  let dropped = 0;
  if (anchors.length > BUDGET) {
    const actions = anchors.filter((a) => a.text.startsWith('agent:'));
    const keepN = Math.max(0, BUDGET - (anchors.length - actions.length));
    // `slice(-0)` returns the WHOLE array, so at keepN===0 the cap silently inverted: every
    // action was kept while the footer reported them all as dropped — wrong in exactly the long
    // sessions the budget exists for.
    const keepSet = new Set(keepN > 0 ? actions.slice(-keepN) : []);
    kept = anchors.filter((a) => !a.text.startsWith('agent:') || keepSet.has(a));
    dropped = actions.length - keepN;
  }
  const body = kept.map((a) => `- \`L${a.line}\` ${a.text}`).join('\n');
  return dropped ? `${body}\n- _(+${dropped} earlier agent actions not listed — read the transcript)_` : body;
}

/**
 * The full engine-verified zone: STATE + footprint + the verbatim IN YOUR WORDS block. Built once
 * for the draft and again at --restate, so the verified region is regenerated atomically and the
 * IN YOUR WORDS block is never clobbered by a STATE refresh.
 */
function buildVerifiedBody(log: string, repo: string, pointers: string[]): string {
  const state = buildState(log, repo, pointers);
  const footprint = sessionFootprint(log, pointers);
  const iyw = buildInYourWords(log);
  // WHAT FAILED belongs in the PROVEN zone: it is read out of the transcript's own error records,
  // so it is evidence like STATE, not recollection like THREAD. The agent adds what the machine
  // cannot see (why an approach was wrong) in its own block below the fence.
  let failed = '';
  try { failed = buildWhatFailed(parseSessionLog(log)); } catch { /* best-effort */ }
  return `${state}${footprint ? `\n${footprint}` : ''}${iyw ? `\n\n${iyw}` : ''}${failed ? `\n\n${failed}` : ''}`;
}

interface SubagentFinding { file: string; pointer: string; finding: string; }

/**
 * Each subagent's VERBATIM final result, engine-extracted (zero model) from its OWN transcript.
 * A subagent's last substantial text IS its returned finding, so lifting it verbatim beats making
 * the agent re-read + paraphrase every (often huge) transcript at handoff time — that's the token
 * win, and verbatim can't fabricate the way a retelling can. The subagent's OWN claims are still
 * unverified; we just carry them faithfully. Subagent transcripts are 100% isSidechain, so we MUST
 * opt in to keep them (the parser drops sidechain turns by default — correct for the MAIN log only).
 */
function buildSubagentDigest(pointers: string[]): SubagentFinding[] {
  // Record EVERY pointer (finding may be '') — a subagent that died or emitted no text still has a
  // raw transcript worth keeping reachable; dropping it would lose discoverability (a net loss).
  return pointers.map((p) => {
    let finding = '';
    try { finding = finalReply(parseSessionLog(p, { includeSidechain: true })); }
    catch { /* unreadable transcript — still keep the pointer below */ }
    // `p` is built by `subagentPointers` with node's own join, so on Windows it is separated by
    // backslashes and `split('/')` returned the entire path as the "file".
    return { file: baseNameOf(p) || p, pointer: p, finding };
  });
}

/** A tool call that failed, and (when there is one) the later call that got past it. */
interface Mishap {
  /** Resolved absolute path, for a file-targeted tool — lets disk settle the outcome. */
  path?: string;
  line: number;
  tool: string;
  target: string;
  /** Full, unclipped identity of the action — what "the same call succeeded later" is judged on. */
  key: string;
  error: string;
  fixedAt?: number;
  refused?: boolean;
}

/** The user refusing a tool call is a boundary, not an error — it must never read as a bug. */
const REFUSAL = /The user doesn't want to (?:proceed|take)|user (?:rejected|denied) (?:this|the) tool/i;

/**
 * A shell command with its leading `cd <path> && ` hops removed. Real commands in this corpus are
 * almost all `cd /some/very/long/path && <the actual command>`, so any prefix-based key collapses
 * unrelated commands into one. That is not cosmetic: it made delulu claim a failure was "cleared
 * later" by a completely different command, inside the block that advertises itself as extracted
 * fact. A field test found 4 of 6 entries in one session carried that false verdict.
 */
const bareCommand = (cmd: string): string => cmd.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, '').trim();

/** The pairing key: FULL text, never clipped — two commands are the same action or they are not. */
const targetKey = (tool: string, inp: Record<string, unknown>): string => {
  if (tool === 'Bash') return bareCommand(String(inp.command ?? ''));
  return (inp.file_path as string) || (inp.notebook_path as string) || (inp.pattern as string) || '';
};

/** The same thing, shortened for display only. */
const targetOf = (tool: string, inp: Record<string, unknown>): string => {
  const k = targetKey(tool, inp);
  if (tool === 'Bash') return clip(k, 80);
  return k ? tailSegments(k, 2) : '';
};

/**
 * WHAT FAILED, extracted rather than remembered.
 *
 * The audit ranked this the highest-value section in the payload — its entries were reused
 * verbatim, repeatedly, and provably saved hours. It was also agent-written from memory, and the
 * audit caught false entries in it (a claim that a whole family of tools was broken, which was
 * wrong). The transcript already knows the truth: every tool_use is joined to its tool_result
 * with an error flag, so failure→fix pairs are a deterministic read, zero model calls.
 *
 * A failure is "fixed" when a later call of the same tool at the same target succeeds. That is
 * evidence, not inference — and where there is no such call, we say so instead of guessing.
 */
/**
 * Commands whose exit 1 means "no match", not "something broke".
 *
 * A compound chain reports only its LAST command's exit code, so a heredoc that wrote its file
 * perfectly and then ran `pkill -f vitest` (nothing running, exit 1) was recorded as a failure.
 * Both entries in one real handoff were this, sitting in the block that advertises
 * itself as engine-extracted fact. Reporting an obstacle that never existed is manufacturing one.
 */
// `diff a b` exiting 1 means "they differ" — the normal answer to a comparison, and the standard
// way an agent verifies two files. Removing it filed every such comparison as a permanent obstacle.
// `cmp` stays out: it is used as a gate far more often than as a query.
//
// `\[` USED TO BE IN THIS LIST AND WAS REMOVED DELIBERATELY — do not put it back.
// It was put there for POSIX `[ -f x ]` test syntax and never matched that: `\b` needs a word
// character straight after the bracket and test syntax always has a space. It only ever matched a
// `[` followed by a word character — a list literal or glob class inside a heredoc — so a failing
// `python3 - <<'XX' … rows = [1,2,3] …` was classed "no-match is fine" and SUPPRESSED from WHAT
// FAILED. Measured over 6,471 real Bash commands from this machine's transcripts: 68 differ
// between the two versions and 3 FAILED calls change their WHAT FAILED outcome — all 3 in the
// direction of reporting a failure that was previously hidden, since removing a suppression can
// only ever turn hidden into reported.
//
// It was also deleted ONCE BY ACCIDENT, under a "dead code" label, on the strength of four POSIX
// examples that all correctly failed to match — the four cases the author thought of, not the
// cases that occur — and reverted, because changing what the engine-verified block reports is not
// something to do sideways. The deletion is now bound by two tests in `mutation-bound guards`:
// one that a list literal no longer suppresses a real failure, one that a genuine `grep` no-match
// is still a non-event.
const NO_MATCH_OK = /(?:^|\s|&&|\|\||;)\s*(?:pkill|pgrep|grep|egrep|fgrep|test|diff)\b[^&|;]*$/;
/** Real trouble looks like this; a query answering "no" does not. */
// `rejected` and `interrupted` are ordinary English words that turn up in the STDOUT of earlier
// commands in a chain ("we rejected the caching idea last week"), and `git push` prints
// "! [remote rejected]" — so unanchored they turned a genuine no-match exit into a manufactured
// obstacle. Anchored to the harness shapes they actually appear in.
const REAL_ERROR = /\b(?:error|fatal|exception|traceback|denied|not found|no such file|cannot|failed to|refus)|\bcommand timed out\b|\[request interrupted|tool use was rejected|doesn't want to proceed/i;

function isNoMatchExit(command: string, errorText: string): boolean {
  if (!command) return false;
  if (!NO_MATCH_OK.test(command)) return false;
  return !REAL_ERROR.test(errorText);
}

/**
 * What is true of this obstacle NOW — three states, never two.
 *
 * The old block had only "cleared later at Lx" and "never got past this", for a question with three
 * real answers. Every unknown was therefore forced into the second and asserted as fact, which is
 * how a failure the agent worked around a DIFFERENT way came to be reported as an impassable wall.
 * A model with fewer states than reality has to lie, and it lies in whichever direction the default
 * points — here, the most alarming one.
 *
 * The transcript alone genuinely cannot answer this. But delulu also reads disk at capture, and for
 * a file-targeted failure the present filesystem settles it outright: the next session starts from
 * now, not from then, so "src/foo.ts still does not exist" is both provable and the thing actually
 * worth knowing. For a shell command there is no disk trace, re-running is not allowed (a capture
 * must never have side effects), and so the honest answer is that we do not know.
 */
/**
 * Resolve a tool's path argument. Claude Code accepts `~/…` in file_path and really does receive it
 * — 14 such calls on this machine, including successful edits. `resolve()` does not expand `~`, so
 * the old form built `<cwd>/~/…`, which never exists: WHAT FAILED then asserted "**that file still
 * does not exist**" about a file sitting on disk, in the block advertised as engine-extracted fact.
 *
 * `startsWith('/')` is also how this went blind on Windows: `C:\repo\a.ts` is not relative, but it
 * failed that test and was then either dropped (no cwd recorded) or resolved by the running
 * machine's rules. WHAT FAILED's whole disk check hangs off the answer, so a wrong one loses the
 * "**that file still does not exist**" line, or asserts it about a path nobody ever named.
 */
function resolvePath(raw: string, cwd?: string): string | undefined {
  return absolutePath(raw, cwd, homedir());
}

/** A file the session opened or wrote SUCCESSFULLY, wherever it turned out to live. */
interface OpenedOk {
  path: string;
  line: number;
}

/** Display form of a path, matching `targetOf`: enough to grep for, not a wall of directories. */
const shortPath = (p: string): string => tailSegments(p, 2);

function outcomeOf(m: Mishap, openedOk: OpenedOk[]): string {
  if (m.fixedAt) return ` — cleared later at \`L${m.fixedAt}\``;
  // Only ABSENCE is settled by disk. Presence proves nothing: an Edit that failed with "String to
  // replace not found", or a Read that failed on size, leaves a file that existed all along — and
  // saying "something wrote it afterwards" turned an unresolved obstacle into a reported success.
  if (!m.path || existsSync(m.path)) return ' — (whether it was resolved afterwards is unknown)';
  // The path is empty. What that PROVES depends on what the path was for, and treating the two
  // cases alike is how this block published a true sentence that misinformed the reader.
  //
  // A WRITE's path is an INTENT — where the agent meant to put something. Empty means the write
  // never landed, which is the obstacle itself, stated exactly.
  //
  // A READ's path is a GUESS — where the agent thought the thing lived. A real capture printed
  //   `L23` `Read` `http/retry.ts` failed: "File does not exist." — **that file still does not exist**
  // above the line that promises everything above it is proven. The retry module was at
  // `pulse/src/net/retry.ts` the whole time and was read successfully further down the same
  // transcript. The engine had re-checked the agent's wrong guess with existsSync, confirmed it,
  // and bolded it; `net/retry` then appeared nowhere in three resume outputs, so the successor's
  // only word on the subject was a fact-checked claim that the module was missing. An empty
  // guessed path proves the GUESS wrong, not the file gone — and the tool's own error already
  // said "File does not exist", so the emphasis was decorating an echo as a discovery.
  if (isMutatingTool(m.tool)) return ' — **that file still does not exist**';
  // A same-NAME file opened later is a lead, and it must be worded as one.
  //
  // The first version of this said "nothing is at that path; `routes/index.ts` was opened at `L4`",
  // which reads as *the thing you wanted is over here* — an identity the engine cannot establish.
  // `index.ts`, `README.md`, `package.json` and `__init__.py` are the commonest filenames there
  // are, so on a basename match alone that sentence pairs unrelated files inside the block the
  // payload certifies as proven. Trading a too-emphatic TRUE statement for a plausible FALSE one is
  // not a fix.
  //
  // Two restrictions make the remaining claim carry its weight, and the wording states exactly what
  // was checked and nothing beyond it. AFTER the failure, because a file opened before it is not
  // evidence about a path the agent guessed afterwards. UNIQUE, because "a file of that name" is
  // only informative when there is one — with several, naming the first is arbitrary and the reader
  // cannot tell that from the sentence.
  // `basename()` from node:path is the RUNNING machine's flavour; these two paths came out of the
  // transcript. On a Windows path read anywhere it compares whole paths, so the "a file of that name
  // was opened at Lx" clue never fires — and `baseNameOf` reads the separator off the strings.
  const named = openedOk.filter((o) => o.path !== m.path && o.line > m.line && baseNameOf(o.path) === baseNameOf(m.path!));
  const unique = named.length === 1 ? named[0] : undefined;
  if (unique) return ` — nothing is at that path; a file of that name was opened at \`L${unique.line}\` (\`${shortPath(unique.path)}\`)`;
  return ' — nothing is at that path (it may have been the wrong path)';
}

function buildWhatFailed(session: ParsedSession): string {
  const calls = new Map<string, { line: number; tool: string; target: string; key: string; path?: string }>();
  const mishaps: Mishap[] = [];
  const okAfter: { line: number; tool: string; key: string }[] = [];
  // Resolved paths a mutating tool later wrote SUCCESSFULLY — the evidence that a failed write was
  // eventually made good, even by a different tool than the one that failed.
  const writtenLater: { path: string; line: number }[] = [];
  // Every file the session opened or wrote successfully, read or write — the evidence that a path
  // the agent GUESSED wrong was a wrong guess and not a missing file. `writtenLater` cannot serve
  // here: it is mutations only, and finding the real file is nearly always a Read.
  const openedOk: OpenedOk[] = [];
  for (const ev of session.events) {
    if (ev.kind === 'tool' && ev.toolUseId && ev.toolName) {
      const inp = (ev.toolInput ?? {}) as Record<string, unknown>;
      const raw = typeof inp.file_path === 'string' ? inp.file_path
        : typeof inp.notebook_path === 'string' ? inp.notebook_path : undefined;
      calls.set(ev.toolUseId, {
        line: ev.line,
        tool: ev.toolName,
        target: targetOf(ev.toolName, inp),
        key: targetKey(ev.toolName, inp),
        path: raw ? resolvePath(raw, ev.cwd) : undefined,
      });
    } else if (ev.kind === 'tool-result' && ev.toolUseId) {
      const call = calls.get(ev.toolUseId);
      if (!call) continue;
      if (ev.ok === false) {
        const error = clip(ev.text ?? '', 220);
        if (!error) continue;
        const refused = REFUSAL.test(error);
        // Check the refusal FIRST. The real refusal string carries no error vocabulary, so a
        // refused `pkill` chain was being discarded as a no-match exit — deleting the one line that
        // says "do not retry this without asking", which is a hard user boundary, not noise.
        if (!refused && isNoMatchExit(call.key, ev.text ?? '')) continue;
        mishaps.push({ ...call, error, refused });
      } else {
        okAfter.push({ line: call.line, tool: call.tool, key: call.key });
        if (call.path) openedOk.push({ path: call.path, line: call.line });
        // Only a MUTATING tool. A successful `Read` also carries file_path, and Write-fails ->
        // Read-the-file is THE canonical recovery flow — so a Read was marking the failed Write
        // "cleared later" while the file on disk still held the old content.
        if (call.path && isMutatingTool(call.tool)) writtenLater.push({ path: call.path, line: call.line });
      }
    }
  }
  if (!mishaps.length) return '';
  for (const m of mishaps) {
    // Identical tool AND identical full command/path, later in the session. Anything looser
    // reports a coincidence as a fix, which is worse than reporting nothing.
    const fix = okAfter.find((c) => c.tool === m.tool && c.key === m.key && c.key !== '' && c.line > m.line);
    if (fix) m.fixedAt = fix.line;
    // A different tool may have written the same file afterwards — still a real fix.
    if (!m.fixedAt && m.path) {
      const w = writtenLater.find((x) => x.path === m.path && x.line > m.line);
      if (w) m.fixedAt = w.line;
    }
  }
  const seen = new Map<string, Mishap>();
  for (const m of mishaps) seen.set(`${m.tool}|${m.key}|${m.error.slice(0, 60)}`, m);
  const all = [...seen.values()];
  const CAP = 12;
  const shown = all.slice(-CAP);
  const lines = shown.map((m) => {
    const where = m.target ? ` \`${m.target}\`` : '';
    if (m.refused) return `- \`L${m.line}\` **you refused** \`${m.tool}\`${where} — do not retry it without asking`;
    return `- \`L${m.line}\` \`${m.tool}\`${where} failed: "${m.error}"${outcomeOf(m, openedOk)}`;
  });
  const more = all.length > CAP ? `\n- _(+${all.length - CAP} earlier obstacles — see the transcript)_` : '';
  // Says whose errors these are. `buildWhatFailed` parses the MAIN transcript only, so in a
  // subagent-heavy session (eleven of them, in the session that produced this repo's own handoff)
  // not one subagent tool error can appear — under a heading reading "the real tool errors", which
  // a reader takes as the session's errors, not the main agent's share of them.
  return `## ${SECTION.broke} — tool errors from this session, pulled from the transcript, each with where it stands now (errors from subagents aren't here; they live in each subagent's own transcript)\n${lines.join('\n')}${more}`;
}

/**
 * The transcript lines where the user actually spoke — written beside the payload so a citation
 * can still be checked in a fresh session, months later, with the transcript long since rotated.
 */
function citableUserLines(log: string): number[] {
  try {
    // Interrupts are excluded: pressing Escape is an ACT, not an utterance. A decision citing one
    // would pass the check while pointing at a line where the user said nothing at all.
    return [...new Set(
      userUtterances(parseSessionLog(log)).kept.filter((u) => u.kind !== 'interrupt').map((u) => u.line),
    )].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * What the user actually SAID at each citable line — so a decision quoting them can be checked
 * against the words, not just the address. Kept beside the payload because the transcript it came
 * from is rotated, compacted or deleted long before the handoff stops being read.
 *
 * Stored up to UTTERANCE_CAP, and the clipped LENGTH is recorded alongside — a fragment quoted
 * from beyond the cap cannot be matched, and without that record it would be reported as a
 * fabrication. (This said "stored in full rather than clipped" until 38c6491 introduced the cap,
 * and for two commits after.)
 */
/**
 * How much of each message is kept for the words-check.
 *
 * The record was stored in full and uncapped: one 5.6MB pasted message produced a 5.8MB
 * citations.json beside a 4.7KB payload, times fifteen retained handoffs. The cap is 3x what the
 * payload itself ever SHOWS of a message (700 chars), and the agent writes its quotes by reading
 * the payload — so a quote it can actually see always falls inside the stored text.
 */
const UTTERANCE_CAP = 2_000;
/** A single file path's room in the STATE block. Long enough for real monorepo paths, bounded so
 *  one pathological name cannot crowd out the eleven others the line promises to show. */
const PATH_CAP = 160;

function citableUtterances(log: string): { utterances: Record<number, string[]>; truncated: Record<number, number>; recommended: Record<number, string[]> } {
  const out: Record<number, string[]> = {};
  const trueLength: Record<number, number> = {};
  const recommended: Record<number, string[]> = {};
  try {
    for (const u of userUtterances(parseSessionLog(log)).kept) {
      if (u.kind === 'interrupt') continue;
      // Same line can carry several utterances (an answer record holds one per question) — kept as
      // SEPARATE entries, not joined. Joining them with a space fused two answers to two different
      // questions into one string, and a quote spanning the seam then verified: "others later
      // Failures must surface" passed as the user's words, and they never said that sentence. The
      // check now matches a fragment against one answer at a time.
      // redact() for the same reason the payload does, and for one more: the payload shows the
      // user `[redacted-secret]`, so an agent quoting them FAITHFULLY quotes the redacted form.
      // Storing the raw text here would make that honest quote fail the words-check and be
      // reported as a fabrication — a false accusation manufactured by the mismatch.
      const text = redact(u.text);
      const stored = text.length > UTTERANCE_CAP ? text.slice(0, UTTERANCE_CAP) : text;
      (out[u.line] ??= []).push(stored);
      // WHOSE WORDS THESE ARE, carried into the record so the check can still tell months later.
      //
      // `kind === 'answer'` means the answer was, exactly and entirely, option labels the AGENT
      // wrote (see `offeredLabels`/`classifyAnswer`); the "(Recommended)" suffix means the agent
      // also told the user which one to press. A DECIDED line whose only proof is that string is
      // the agent quoting itself — measured at 9 of 16 decisions in this repo's 2026-08-20 handoff,
      // 8 of 15 the session before, 4 of 14 before that, and 13 of 21 before that. NOT rising: it
      // starts at its maximum. The "0 of 21" this comment used to carry came from grepping for the
      // literal "(Recommended)" suffix, which that payload had trimmed off 13 of its quotes — the
      // probe scored formatting, not provenance.
      //
      // Stored as the TEXT rather than an index into `out[line]`: an index is silently wrong the
      // day the two arrays are built in different orders, and "silently wrong about whose words
      // these are" is the exact defect this whole file exists to catch. The labels are short, so
      // the duplication costs nothing worth counting.
      if (u.kind === 'answer' && RECOMMENDED_LABEL.test(stored)) (recommended[u.line] ??= []).push(stored);
      // Record the REAL length of anything clipped, so the checker can say "cannot verify — this
      // message was too long to store in full" instead of "you never said that". A cap that can
      // manufacture a false accusation is worse than no cap at all.
      if (text.length > UTTERANCE_CAP) trueLength[u.line] = Math.max(trueLength[u.line] ?? 0, text.length);
    }
  } catch { /* no record beats a wrong one */ }
  return { utterances: out, truncated: trueLength, recommended };
}

/**
 * Did the user contribute anything at all to this session — prose, or an answer to a question?
 *
 * Fails OPEN on a parse error: an unreadable transcript is a reason to capture what we can, never
 * a reason to refuse. The only thing this is allowed to stop is a session that provably has no
 * user in it.
 */
/** Whether the transcript can be read at all, so the refusal can name the real cause. */
function readable(log: string): boolean {
  try { readFileSync(log, 'utf8'); return true; } catch { return false; }
}

function hasAnyUserInput(log: string): boolean {
  // A transcript that cannot be READ is not a parse gap, and the two used to share this catch.
  // Every extractor below swallows its own read error and returns nothing, so an unreadable
  // transcript — a permissions change, a root-owned file from a `sudo claude` run, an I/O error on
  // a network mount, or Claude Code renaming the file out from under a capture — produced a handoff
  // with NO "What you said" block at all, an empty citations.json, exit 0, and no warning. That
  // folder is newest, so it then shadowed the real handoff underneath it in `resume` and `--list`.
  //
  // Degrading OPEN is right for the case the catch below was written for: the file reads fine and
  // our extractor does not understand a shape in it. It is wrong for no data at all.
  try {
    readFileSync(log, 'utf8');
  } catch {
    return false;
  }
  try {
    const u = userUtterances(parseSessionLog(log));
    if (u.prose > 0 || u.kept.length > 0) return true;
    // The extractor coming back empty is NOT proof the user was silent — it is equally the
    // signature of an answer shape we do not parse yet. That combination already cost a real
    // session: a `selected preview:` record yielded no pairs, so a session steered entirely by
    // picking options looked silent and the handoff was refused outright. Refusing on our own
    // parse gap is the degrade-CLOSED failure this tool is not allowed to have, so if the raw
    // transcript plainly contains an answer record, capture it and let the block be thin.
    return /"\s*=\s*"|have been answered/.test(readFileSync(log, 'utf8'));
  } catch {
    return true;
  }
}

/** The transcript's identity: the file it resolves to, so two spellings of one path compare equal. */
function resolvedLogPath(log: string): string {
  try { return realpathSync(log); } catch { return resolve(log); }
}

function writeCitations(dir: string, log: string): void {
  try {
    const userLines = citableUserLines(log);
    // Never replace a real record with an empty one — the merge rule again, in the third place it
    // was missing. On an unreadable transcript every extractor catches and returns nothing, and
    // this wrote `{"userLines":[],"utterances":{}}` over the existing record. The citation check
    // then reported every honest DECIDED line as untraceable: delulu deleting the evidence and
    // accusing the agent of fabricating from it, in one run.
    if (!userLines.length && existsSync(join(dir, 'citations.json'))) {
      try {
        const prior = JSON.parse(readFileSync(join(dir, 'citations.json'), 'utf8')) as { userLines?: unknown };
        if (Array.isArray(prior.userLines) && prior.userLines.length) return;
      } catch { /* unreadable prior record — writing a fresh one is the better of two bad options */ }
    }
    writeFileSync(
      join(dir, 'citations.json'),
      // RESOLVED, not as handed in. The reseal guard identifies the session by resolving this path
      // and comparing — so a relative `--log session.jsonl` recorded verbatim was resolved against
      // the RESEAL run's cwd, named a file that was not there, and refused a reseal of the handoff
      // this very session had captured. Storing what the path resolves to now, while the capture
      // run's cwd is still the right one to resolve against, is what makes the two runs comparable
      // at all. Falls back to the raw string if it cannot be resolved, which leaves the guard
      // exactly as strict as it was rather than silently opening it.
      JSON.stringify({ userLines, ...citableUtterances(log), log: resolvedLogPath(log) }, null, 1),
      // 0600 like every other artifact. This one holds every message the user typed, verbatim up to
      // UTTERANCE_CAP — it was the ONLY artifact still world-readable, the worst one to miss.
      { mode: 0o600 },
    );
  } catch { /* best-effort: a missing citation record degrades to "cannot check", never to a lie */ }
}

/** Pointers to this session's raw subagent transcripts (kept on disk, never copied). */
function subagentPointers(log: string): string[] {
  try {
    const dir = join(log.replace(/\.jsonl$/, ''), 'subagents');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * The already-ignored test must tolerate surrounding whitespace. git ignores trailing spaces on a
 * .gitignore line and indentation is invisible in an editor, so `.delulu-handoff/ ` is a WORKING
 * ignore rule that the strict anchored pattern did not recognise — and every single handoff then
 * appended ANOTHER `.delulu-handoff/` line to a tracked file, forever, without saying a word.
 * (CRLF is not a case: ECMAScript counts `\r` as a LineTerminator, so `$` under /m already matches
 * before it. The CRLF test below is a regression guard, not a fix.)
 */
const IGNORED_LINE = /^[ \t]*\.delulu-handoff\/?[ \t\r]*$/m;

/**
 * Keep `.delulu-handoff/` out of git — and SAY SO when that cannot be done.
 *
 * Failing silently was the dangerous part: with a read-only .gitignore the write threw, the catch
 * swallowed it, capture reported success, and the folder sat untracked-and-committable holding the
 * whole session verbatim. A `git add -A` then put it in a commit. delulu shows and never blocks, so
 * this warns rather than refusing — but it must not claim success it did not have.
 *
 * The already-TRACKED case is separate and unfixable by an ignore line: git keeps tracking a file
 * it already knows. That needs `git rm -r --cached`, which is the user's call, so we name it.
 */
function ensureGitignored(repo: string): string {
  let warn = '';
  // Outside a git repo there is nothing to ignore and nothing to reassure anybody about. delulu
  // still captures here — `--repo` names where the handoff is STORED, and that need not be a
  // checkout — but writing a `.gitignore` into a plain directory is litter, and announcing that it
  // keeps content "out of a commit" is a promise about a repository that does not exist. This file
  // holds delulu to saying only what it checked; the same standard applies to its own side effects.
  if (git(repo, ['rev-parse', '--git-dir']) === undefined) return warn;
  try {
    const gi = join(repo, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    if (!IGNORED_LINE.test(cur)) {
      try {
        writeFileSync(gi, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '.delulu-handoff/\n');
        // Said ONCE, on the run that adds the line, and never again. Ignoring the folder is the
        // right call — it is what keeps a session's verbatim content out of a commit — but it puts
        // every handoff inside the blast radius of `git clean -xdf`, which exists to delete exactly
        // what git is ignoring. delulu wrote the rule, so delulu owes the consequence.
        warn += `delulu handoff — added \`.delulu-handoff/\` to .gitignore, so your session content can never reach a commit. Worth knowing: that also puts your handoffs in reach of \`git clean -xdf\`, which deletes ignored files. They live nowhere else.\n`;
      } catch {
        warn += `delulu handoff — could NOT add \`.delulu-handoff/\` to .gitignore (is it read-only?). Your session content is not ignored and can reach a commit. Add the line yourself before committing.\n`;
      }
    }
  } catch { /* reading it failed; the tracked check below still runs */ }
  const tracked = git(repo, ['ls-files', '--', '.delulu-handoff']);
  if (tracked) {
    const n = tracked.split('\n').filter(Boolean).length;
    warn += `delulu handoff — ${n} handoff file(s) are already TRACKED by git, which .gitignore cannot undo. To untrack them: \`git rm -r --cached .delulu-handoff\`\n`;
  }
  return warn;
}

/**
 * How many COMPLETED handoffs to keep. Anything older is pruned at write time (`pruneHandoffs`).
 *
 * This was a bare number with no reasoning beside it, which is how a number nobody can check
 * survives — and it governs the only irreversible thing delulu does. `.delulu-handoff/` is
 * gitignored, so a handoff this deletes is gone, and the prune logic here has twice deleted real
 * ones while reporting that it was keeping them.
 *
 * The asymmetry, written down so the next person does not re-guess it. Too HIGH costs disk and a
 * slightly longer `--list`: handoffs in this repo run 28KB to 204KB, so thirty of them is about
 * 4MB and thirty file reads, neither of which anybody would notice. Too LOW costs a handoff that
 * cannot be recovered from anywhere. Those are not comparable, and the number should sit far from
 * the cheap side of the trade rather than in the middle.
 *
 * 15 is generous against real use and stays. Measured 2026-09-07 on this library: eight completed
 * handoffs across three months, and unfinished drafts have counted toward nothing since `426bd1d`,
 * so this ceiling now applies only to finished work. At that pace fifteen is roughly six months.
 * If capture ever becomes routine enough that the pace changes, this number is the first thing to
 * raise, and raising it is close to free.
 */
const KEEP_HANDOFFS = 15;

/**
 * How many unfinished drafts may pile up before prune SAYS SO. It never deletes one.
 *
 * Drafts are exempt from pruning and, since `426bd1d`, uncounted against `KEEP_HANDOFFS` — which
 * fixed drafts evicting finished handoffs and left them growing with no ceiling at all. Two sit in
 * this repo today and a quarter of the captures ever started here were abandoned mid-interview, so
 * the pile is a normal outcome of the tool, not an accident.
 *
 * The fix is a sentence, not a delete. Retention code here has form: it once removed the six
 * NEWEST handoffs while printing that it was keeping them, into a gitignored directory with nothing
 * to recover from. An abandoned draft still holds the user's verbatim words and is the one artifact
 * they cannot regenerate, so the only safe move is to make the pile visible and let them choose.
 */
const MENTION_DRAFTS_ABOVE = 3;

/**
 * Prune the handoff library down to the newest `KEEP_HANDOFFS`.
 *
 * Nothing ever pruned these: one real repo accumulated 26 folders / 5.7MB, and `resume --list`
 * reads and regexes EVERY payload on every invocation, so the cost of listing grows with each
 * session and never comes back down. Two things are never deleted: the folder being written, and
 * any handoff that still carries unfilled `<!-- delulu:fill` placeholders — an unfinished handoff
 * is work nobody has read yet, and the user may still come back to it. Returns the line to print;
 * a silent delete is exactly what this project refuses to do.
 */
/**
 * A handoff folder delulu itself created: the exact timestamp shape `stamp()` produces, plus the
 * `-2`, `-3` suffix used for a same-second collision. Anything else in `.delulu-handoff/` — a
 * folder the user named `keep-this`, a copy, an archive — is never a deletion candidate.
 */
const HANDOFF_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

/** How far ahead of now a timestamp may sit before it means "bad clock" rather than "just written". */
const FUTURE_SLACK = 5 * 60 * 1000;

/** Chronological order for two handoff folder names, comparing the collision suffix as a number. */
function cmpStamp(a: string, b: string): number {
  const [as, an] = [a.slice(0, 19), Number(a.slice(20) || 1)];
  const [bs, bn] = [b.slice(0, 19), Number(b.slice(20) || 1)];
  return as < bs ? -1 : as > bs ? 1 : an - bn;
}

function pruneHandoffs(base: string, keepFolder: string): string {
  try {
    // Read once: "future" must mean the same instant for every folder in this ranking.
    const now = Date.now();
    const folders = readdirSync(base)
      .filter((f) => {
        // A folder with no payload.md is either half-written or not a handoff at all; it is never
        // counted and never deleted. Nor is anything delulu did not name itself.
        if (!HANDOFF_FOLDER.test(f)) return false;
        try { return statSync(join(base, f)).isDirectory() && existsSync(join(base, f, 'payload.md')); }
        catch { return false; }
      })
      // Ranked by MTIME, not by name. The old `.sort().reverse()` assumed every name is a
      // well-formed stamp and that the clock never went backwards; neither holds. With the machine
      // a year ahead and then corrected, fifteen junk `2027-*` folders outranked the real handoff
      // written minutes earlier, and it was deleted while the message claimed "keeping the newest
      // 15". `.delulu-handoff/` is gitignored, so that deletion is unrecoverable. The collision
      // suffix inverted too: `-10` sorted below `-2`.
      // A folder dated in the FUTURE ranks LAST, never first.
      //
      // Ranking by mtime was supposed to survive a bad clock, and it does not: a skewed clock
      // stamps the folder NAME and its mtime alike, so fifteen junk `2027-*` folders outranked the
      // real handoff written minutes after the correction, and it was deleted and reported as an
      // "old handoff" — unrecoverable, `.delulu-handoff/` being gitignored. A timestamp from after
      // now is not evidence of being newest; it is evidence of a clock that cannot be trusted, and
      // the least trustworthy artifact in the directory is the right one to prune first. The
      // handoff being written now is never at risk: it is `keepFolder`, which prune never touches.
      .map((f) => {
        let m = 0;
        try { m = statSync(join(base, f)).mtimeMs; } catch { m = 0; }
        const named = Date.parse(`${f.slice(0, 10)}T${f.slice(11, 19).replace(/-/g, ':')}Z`);
        // SLACK, because "future" must mean a broken clock, not a rounding artefact. APFS records
        // sub-millisecond mtimes while `Date.now()` truncates to whole milliseconds, so the folder
        // written microseconds ago reads as fractionally ahead of now — and without slack the
        // handoff being captured right now ranked LAST, which silently changed which old ones were
        // pruned. The case this rule exists for is a clock a YEAR out; minutes of tolerance costs
        // nothing against that.
        const future = m > now + FUTURE_SLACK || (Number.isFinite(named) && named > now + FUTURE_SLACK);
        return { f, m: future ? -1 : m };
      })
      // Ties broken by the timestamp NAME, never left to `readdirSync` order. `Array#sort` is
      // stable, so equal mtimes fell through to directory order and prune deleted the SIX NEWEST
      // handoffs while keeping the fourteen oldest — printing "keeping the newest 15 by
      // modification time" in the same line. Equal mtimes are not exotic: any `cp -R`, tar/zip
      // extraction, Docker COPY or `rsync` without `-t` flattens them, as does a 2-second-
      // granularity filesystem. The suffix is compared numerically so `-10` outranks `-2`.
      .sort((a, b) => b.m - a.m || cmpStamp(b.f, a.f))
      .map((x) => x.f);
    // FILTER FIRST, THEN SLICE. An incomplete handoff is protected from deletion by the predicate
    // below — and counting it toward KEEP_HANDOFFS anyway meant a burst of aborted captures filled
    // every retention slot while being immune to pruning, so the only folders still eligible were
    // the FINISHED ones underneath. Measured on this repo: 10 unfinished drafts written over 20
    // minutes evicted three completed handoffs, and `.delulu-handoff/` is gitignored, so there was
    // nothing to recover from. The protection rule was itself causing the loss.
    //
    // Raising KEEP_HANDOFFS does not fix this — any number of junk drafts fills any number of
    // slots. Only ranking what can actually be pruned does.
    // Counted from the same `folders` list prune ranks, so this can never describe a directory
    // prune did not actually look at. `keepFolder` is excluded because the handoff being written
    // right now is not a leftover, whatever state its payload is in mid-write.
    const drafts = folders.filter((f) => {
      if (f === keepFolder) return false;
      try { return isIncompletePayload(readFileSync(join(base, f, 'payload.md'), 'utf8')); }
      catch { return false; }
    });
    const prunable = folders.filter((f) => {
      if (f === keepFolder) return false;
      // The SAME predicate resume uses. Two definitions of "unfinished" meant a handoff resume
      // called incomplete could still be pruned — while the message printed the promise that
      // unfinished handoffs are never pruned, in the line that named the victim.
      try { return !isIncompletePayload(readFileSync(join(base, f, 'payload.md'), 'utf8')); }
      catch { return false; } // unreadable -> leave it alone; deleting on a read error is not safe
    });
    const stale = prunable.slice(KEEP_HANDOFFS);
    const gone: string[] = [];
    const failed: string[] = [];
    for (const f of stale) {
      try { rmSync(join(base, f), { recursive: true, force: true }); gone.push(f); }
      catch { failed.push(f); }
    }
    // A partial delete used to be silent: rmSync removes children first, so a throw part-way left a
    // gutted folder with no payload.md — invisible to `resume --list` and permanently immune to
    // prune — while nothing at all was printed. Say it.
    // Said whether or not anything was pruned: the pile is the point, not the pruning.
    const drafted = drafts.length > MENTION_DRAFTS_ABOVE
      ? `delulu handoff — ${drafts.length} unfinished drafts are sitting in .delulu-handoff/. They are never pruned, because an abandoned draft still holds your words. Delete any you do not want: ${drafts.slice(0, 3).join(', ')}${drafts.length > 3 ? `, +${drafts.length - 3} more` : ''}.\n`
      : '';
    const warn = failed.length
      ? `delulu handoff — could not fully remove ${failed.length} old handoff folder(s): ${failed.slice(0, 3).join(', ')}. They may be partly deleted; check them.\n`
      : '';
    if (!gone.length) return warn + drafted;
    const named = gone.slice(0, 5).join(', ') + (gone.length > 5 ? `, +${gone.length - 5} more` : '');
    return `${warn}${drafted}delulu handoff — pruned ${gone.length} old handoff(s), keeping the newest ${KEEP_HANDOFFS} COMPLETED handoff(s) by modification time (handoffs with unfilled sections are never pruned, and no longer count toward that limit): ${named}\n`;
  } catch {
    return ''; // pruning is housekeeping: it must never cost you the handoff you just captured
  }
}

/**
 * The stable identity of an engine section: its NAME, not its whole heading line.
 *
 * Keying on the whole line was the defect. `buildInYourWords` emits TWO different heading lines for
 * the SAME section — "every message you sent this session" when everything fit, and
 * "… (80 of 120 shown)" when the budget forced an elision — so a draft sealed under one heading and
 * a reseal producing the other were merged as two different sections, and BOTH were kept. The
 * result is the exact failure `76869e0` added this merge to prevent: a stale draft-time IN YOUR
 * WORDS block sitting below WHAT FAILED under a heading claiming completeness, contradicting the
 * fresh block above it, while `--restate` printed "refreshed from the transcript". It compounded —
 * a second reseal produced a third block.
 *
 * The name is everything before the em-dash, which is where every engine heading puts its subtitle;
 * a heading without one keys on itself. Deliberately NOT a list of known section names: an
 * enumeration is the shape that has failed in every round of this review, and a heading this does
 * not recognise still keys on itself, which is exactly the old behaviour.
 *
 * A COLLISION DROPS THE SECOND SECTION SILENTLY. Two headings that share a name are merged and the
 * later one is discarded with no warning. No engine heading can collide — the merged slice starts
 * AFTER `## STATE`'s own line and ends at the fence, so the only keys that occur are
 * `## IN YOUR WORDS` and `## WHAT FAILED`, and `clip` collapses whitespace so no user message or
 * tool error can inject a line starting `## `. It is reachable only by a heading hand-written into
 * the verified zone, which the instructions call FINAL and tell the agent never to edit. Verified
 * by execution, not argued: `## — alpha` and `## — beta` both key to `##`, and the second is gone
 * after a reseal.
 */
const sectionKey = (head: string): string => head.split(' — ')[0].trim();

/**
 * Split an engine zone into its sections: the lead-in before any `## ` heading, then one entry per
 * heading, keyed by `sectionKey` so a section is matched by identity and not by its exact wording.
 * The heading LINE travels with the body, so whichever side wins prints its own subtitle — the
 * rebuild's, when the rebuild produced the section, because that is the one whose counts are fresh.
 */
function verifiedSections(zone: string): { lead: string; order: string[]; body: Map<string, { head: string; text: string }> } {
  const body = new Map<string, { head: string; text: string }>();
  const order: string[] = [];
  const lines = zone.split('\n');
  let head = '';
  let lead = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n');
    if (!head) lead = text;
    else {
      // First wins, so a payload ALREADY doubled by this defect collapses back to one section on
      // the next reseal rather than staying doubled forever.
      const key = sectionKey(head);
      if (!body.has(key)) { body.set(key, { head, text }); order.push(key); }
    }
    buf = [];
  };
  for (const l of lines) {
    if (/^##\s+\S/.test(l)) { flush(); head = l; }
    else buf.push(l);
  }
  flush();
  return { lead, order, body };
}

/**
 * The refreshed zone: every section the rebuild produced, plus every section it did NOT, kept from
 * the existing payload. Order follows the rebuild, then anything only the old payload had.
 *
 * The lead-in (STATE's own body, which carries no heading of its own) is taken from the rebuild
 * when it produced one, because that is the block whose entire purpose is to be re-read from git.
 */
function mergeVerified(old: string, rebuilt: string): string {
  const a = verifiedSections(old);
  const b = verifiedSections(rebuilt);
  const lead = b.lead.trim() ? b.lead : a.lead;
  const keys = [...b.order, ...a.order.filter((k) => !b.body.has(k))];
  // `\n` between the heading and its body: `verifiedSections` stores the body WITHOUT the newline
  // that separated it from its heading, so concatenating them directly welded the heading onto its
  // first line.
  const out = keys.map((k) => {
    const s = b.body.get(k) ?? a.body.get(k);
    return s ? `${s.head}\n${s.text}` : '';
  });
  return [lead.replace(/\s+$/, ''), ...out.map((s) => s.replace(/\s+$/, ''))].filter(Boolean).join('\n\n');
}

/**
 * Re-capture engine STATE into an EXISTING handoff payload. Run at FINALIZE time (after the
 * interview/edits) so the verified block reflects the repo when the handoff is sealed, not when
 * it was started — closes the window where a commit mid-handoff makes the "verified" SHA lie.
 * Re-derives the WHOLE engine zone (STATE, IN YOUR WORDS, WHAT FAILED) and MERGES it section by
 * section; every agent-written fill below the fence is left untouched. This line used to say "only
 * the STATE block", which stopped being true at 274d817 and was still saying it two commits later.
 */
/**
 * Name a handoff, or replace the name it has.
 *
 * This exists as a FLAG rather than as an instruction to write `name.txt`, because the command that
 * runs the interview is allowed `Bash(node:*), Read, Edit, AskUserQuestion` — and `Edit` cannot
 * create a file that does not exist. An instruction the tooling cannot carry out is not a feature;
 * it is a silence. Every handoff captured after naming shipped would have been called
 * "Aug 27 handoff" while the six named by hand looked fine.
 */
function nameHandoff(repo: string, folder: string, raw: string): void {
  if (!HANDOFF_FOLDER.test(folder)) {
    failed(`\`--restate ${folder}\` is not a handoff timestamp, so nothing was named. Use the folder name from \`delulu resume --list\`.`);
    return;
  }
  const base = join(repo, '.delulu-handoff');
  if (!existsSync(join(base, folder, 'payload.md'))) {
    failed(`there is no handoff at .delulu-handoff/${folder}, so nothing was named.`);
    return;
  }
  const stored = writeName(base, folder, raw);
  if (!stored) {
    failed(`\`--name\` needs some words in it. Nothing was named.`);
    return;
  }
  process.stdout.write(`delulu — this handoff is now called "${stored}". That is how it will show up in \`delulu resume --list\`, and how you load it: \`delulu resume "${stored.split(' ').slice(0, 2).join(' ')}"\`.\n`);
}

function restate(repo: string, log: string, folder: string): void {
  // `folder` is interpolated straight into a path. Without this, `--restate ../../elsewhere` wrote
  // a payload.md two directories above the repo. Only names delulu itself produces are accepted.
  if (!HANDOFF_FOLDER.test(folder)) {
    failed(`\`--restate ${folder}\` is not a handoff timestamp, so NOTHING was rewritten. Use the folder name from \`delulu resume --list\`, e.g. 2026-08-14T10-30-00.`);
    return;
  }
  const payloadPath = join(repo, '.delulu-handoff', folder, 'payload.md');
  if (!existsSync(payloadPath)) {
    process.stdout.write(`delulu handoff — no handoff at .delulu-handoff/${folder} to refresh (nothing was rewritten). Run \`delulu handoff\` first, or check the timestamp with \`delulu resume --list\`.\n`);
    process.exitCode = 1;
    return;
  }
  // ONLY THE NEWEST HANDOFF MAY BE RESEALED.
  //
  // The previous guard compared the transcript's SESSION ID and it tested the wrong proposition. A
  // resumed session keeps appending to ONE transcript, so every handoff it ever captured records
  // the same id — on this machine `2026-08-15T02-28-30` and `2026-08-16T21-33-53` both point at
  // the same transcript file, forty hours apart. "Same session" is true of both, so resealing the older
  // one passed: its verified zone and its record of what the user said were replaced with today's
  // capture, exit 0, no warning. That is the single most likely mistarget — adjacent timestamps,
  // one digit off, both offered by `delulu resume --list`.
  //
  // The positive invariant is simpler than any enumeration of ways to mistarget: a sealed handoff
  // is a record of a moment and never moves again; the only one still being written is the newest.
  // In the real flow the draft this run just created IS the newest, so STEP 4 always works.
  const base = join(repo, '.delulu-handoff');
  const newest = readdirSync(base)
    .filter((f) => HANDOFF_FOLDER.test(f) && existsSync(join(base, f, 'payload.md')))
    .sort(cmpStamp)
    .pop();
  if (newest && newest !== folder) {
    failed(`.delulu-handoff/${folder} is not the newest handoff (${newest} is), so NOTHING was rewritten. A sealed handoff is a record of a moment and never moves again — resealing it would replace its verified zone, and its record of what you said, with THIS session's. Re-run \`--restate ${newest}\`, or \`delulu handoff\` for a fresh draft.`);
    return;
  }

  // And the provenance record must EXIST and match. This catch used to swallow a missing record
  // with "an older handoff predates it; carry on" — degrading OPEN on the one write that can
  // destroy an unrecoverable artifact. Backwards: an older handoff is precisely the one not to
  // touch. A folder in this very repo has no `citations.json`, and resealing one such
  // from an unrelated session replaced 31 verbatim messages with a single line from that session,
  // under a heading reading "every message you sent this session".
  const recordPath = join(base, folder, 'citations.json');
  let prior: { log?: unknown } | null = null;
  try { prior = JSON.parse(readFileSync(recordPath, 'utf8')) as { log?: unknown }; } catch { prior = null; }
  if (!prior || typeof prior.log !== 'string' || !prior.log) {
    failed(`.delulu-handoff/${folder} has no readable citations.json, so delulu cannot prove which session captured it — and NOTHING was rewritten. Resealing a handoff it cannot identify is how an older one gets overwritten with this session's words, which is unrecoverable. Run \`delulu handoff\` for a fresh draft and reseal that.`);
    return;
  }
  // Identity is THE FILE, not what it is called.
  //
  // This compared `p.split('/').pop()` — the filename — so two transcripts that merely SHARE a
  // basename read as one session. Reproduced: `sessA/session.jsonl` captured a handoff, then
  // `--log sessB/session.jsonl --restate <that folder>` rewrote it with the other conversation's
  // words — "bravo one: delete everything" appearing under "every message you sent, in order,
  // straight from the transcript", and citations.json replaced too, exit 0, nothing printed. The
  // name `session.jsonl` is what every hand-driven `--log` and every fixture is called; only a real
  // Claude Code transcript is named after a UUID that happens to be unique.
  //
  // The loose form existed for a real reason and this keeps it: ONE transcript reaches this code
  // under more than one name — `/tmp/x` and `/private/tmp/x` are the same file on macOS, and `--log`
  // may be relative on the capture run and absolute from `resolveLog` on the reseal. `realpath`
  // is the honest version of that intent: it collapses those names to the one file they name,
  // instead of throwing away the directory and hoping the tail is unique. So both directions hold
  // — a legitimate reseal through a symlinked path still resolves equal, and a different session
  // no longer passes on a coincidence of naming.
  //
  // When the recorded transcript no longer resolves (pruned, renamed by Claude Code, an unmounted
  // volume) its identity cannot be established at all, and the normalized strings are all that is
  // left. Refusing there is the direction the missing-record guard above already chose: this write
  // replaces a record that exists nowhere else.
  const fileId = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (fileId(prior.log) !== fileId(log)) {
    failed(`.delulu-handoff/${folder} was captured from a DIFFERENT session (\`${prior.log}\`), and this one is \`${log}\`. NOTHING was rewritten — resealing it would replace that session's record of the user's words with this session's, unrecoverably. Run \`--restate\` on the folder this session created, or \`delulu handoff\` for a fresh one.`);
    return;
  }

  const cur = readFileSync(payloadPath, 'utf8');
  const headMatch = cur.match(new RegExp(`## ${SECTION.state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n`));
  const fenceAt = cur.indexOf(AGENT_ZONE);
  if (!headMatch || headMatch.index === undefined || fenceAt === -1) {
    process.stdout.write(`delulu couldn't find the checked block in .delulu-handoff/${folder}/payload.md, so nothing was refreshed — what's in there is still from when it was drafted. Run \`delulu handoff\` for a fresh draft rather than editing that block by hand.\n`);
    process.exitCode = 1;
    return;
  }
  // Re-derive the WHOLE engine zone, not just STATE.
  //
  // Preserving the tail by position was written to stop a refresh DELETING a section, and it does —
  // but it also froze two blocks whose truth is defined at seal time, in the zone labelled
  // engine-verified:
  //   · WHAT FAILED's outcome line is `existsSync` NOW ("**that file still does not exist**").
  //     Sealed from draft time it kept asserting absence for files created since — by a shell
  //     command, a build, or a subagent, which is every path a main-agent Edit does not cover.
  //   · IN YOUR WORDS claims "every message you sent this session". The interview happens BETWEEN
  //     the draft and the seal, so the densest decisions in the session — the answers — were
  //     missing from it. Provably: this repo's own `2026-08-16T21-33-53` payload says 91 messages
  //     and its `citations.json`, rewritten three minutes later by this very function, holds 92.
  //     The engine knew the message existed and printed the absolute claim anyway.
  // `buildVerifiedBody` produces the complete zone — state, footprint, IN YOUR WORDS, WHAT FAILED —
  // so rebuilding from it cannot drop a section the way the old partial rebuild did, and a block
  // added there later is refreshed automatically instead of silently going stale.
  if (fenceAt <= headMatch.index) {
    failed(`The sections in .delulu-handoff/${folder}/payload.md are out of order — the dividing line sits above the checked block instead of below it — so nothing was rewritten. Refreshing it in that state used to duplicate the whole file and report success. Run \`delulu handoff\` for a fresh draft rather than editing it by hand.`);
    return;
  }
  const stateStart = headMatch.index + headMatch[0].length;
  const pointers = subagentPointers(log);
  const rebuilt = buildVerifiedBody(log, repo, pointers);
  // MERGE, section by section — the rebuild may REPLACE a section but can never REMOVE one.
  //
  // My guard for this was `if (!block.trim())`, and it was dead code: `buildState` always pushes
  // the branch line, so the block is never blank. With no guard, any partial rebuild WROTE, and
  // writing short means deleting. An unreadable transcript (every extractor catches and returns '')
  // deleted IN YOUR WORDS and WHAT FAILED from a sealed payload, exited 0, and printed that it had
  // refreshed them — then accused the DECIDED lines of being untraceable, because it had just
  // deleted what they trace to.
  //
  // A guard is an enumeration of the ways a rebuild can come back short, and enumerations are what
  // has failed in every round of this review. This is not a guard: a section absent from the
  // rebuild keeps its existing text, so deletion is not something that must be prevented — it is
  // something the code cannot express. It is the rule already locked for messages ("carry every
  // message by shortening rather than deleting"), applied one level up, to the sections holding
  // them. A broken rebuild now leaves content stale-but-present, which is the direction this
  // codebase chooses everywhere else.
  const block = mergeVerified(cur.slice(stateStart, fenceAt), rebuilt);

  // Finalize is the moment the agent's filled sections exist, so it is the moment to check whether
  // what it filed under DECIDED can be traced to the user. Shown, never blocked.
  writeCitations(join(base, folder), log);
  const cites = citableUtterances(log);
  const notice = citationNotice(checkCitations(cur, citableUserLines(log), cites.utterances, cites.truncated, {
    recommended: cites.recommended,
    // A decision carried forward names the handoff it came from, and that handoff's own record is
    // sitting right here in `base`. Resolving it is what makes "the user locked this two sessions
    // ago" checkable instead of scoring `bad` against a transcript it was never in.
    carried: carriedLookup(base),
  }));
  // `sealed` is kept as a binding because the delivery-size check below reads it: a payload that
  // would die in the pipe has to be caught at the moment it is sealed, not only at load.
  const sealed = cur.slice(0, stateStart) + block + '\n\n' + cur.slice(fenceAt).replace(/^\n+/, '');
  writeFileSync(payloadPath, sealed, { mode: 0o600 });
  // Says what it actually did. "every other section preserved exactly" was true of the old
  // preserve-by-position form and became a false statement the moment the engine blocks started
  // being re-derived — the agent-written sections are the ones preserved, and the whole point of
  // this pass is that IN YOUR WORDS and WHAT FAILED are NOT frozen at draft time.
  // Same reason as the draft echo: `block` is what was just written to the file, and reprinting it
  // spends the ending session's context on bytes it can read from disk if it needs them.
  process.stdout.write(`delulu re-read the checked blocks for ${folder} — "${SECTION.state}", "${SECTION.said}" and "${SECTION.broke}" come straight from the transcript again (${deliveryBytes(block).toLocaleString('en-US')} bytes, in the file). Nothing the agent wrote was touched.\n`);
  if (notice) process.stdout.write(`\n${notice}`);
  // AFTER the citation notice, and separate from it. That one is about whether a line is TRUE; this
  // one is about how long it lives. Folding them together would file a sorting question under a
  // heading that says lines could not be traced to something the user said.
  const misSorted = sortingNotice(cur);
  if (misSorted) process.stdout.write(`\n${misSorted}`);
  // LAST, because it is the only one of the three that is about something ABSENT. The citation
  // notice grades lines that are here; the sorting question asks where a line that is here belongs;
  // this names what is not here at all, which is the failure the other two cannot see.
  const loss = droppedCarried(base, folder, cur);
  // Named, never stamped. `2026-08-20T03-48-19` is not something a person should be made to read;
  // the user locked that at `L190` ("this part looks badd so baddd").
  const lost = carryItems(loss, loss ? handoffLabel(base, loss.stamp, new Date()) : '');
  if (lost.lost.length)
    process.stdout.write(`\ndelulu — ${lost.lost.length} constraint(s) carried out of an earlier handoff are NOT in this one, and each said a check could not hold it:\n`
      + lost.lost.map((t) => `  ! ${t}\n`).join('')
      + `  Nothing is blocked and nothing was rewritten. If the user retired them, that is the right outcome — say which, and why, under "${SECTION.read}". If not, put them back with their original refs before this handoff seals.\n`);
  // The other end of the same rule. A block that only reports LOSSES lets anything be added back
  // unexamined, which is how it reached 29 lines while every session along the way looked sensible.
  if (lost.unjustified.length)
    process.stdout.write(`\ndelulu — ${lost.unjustified.length} line(s) kept under "${SECTION.holds}" do not say why a check could not hold them. A constraint a test can hold belongs in the test, where it is enforced rather than described and costs the next session nothing to read:\n`
      + lost.unjustified.map((t) => `  ? ${t}\n`).join(''));
  for (const note of [lost.untouchedNote, lost.routineNote]) if (note) process.stdout.write(`\ndelulu — ${note}\n`);
  // FINALIZE is where a payload actually reaches its full size — the draft is mostly placeholders,
  // and the interview between them is what fills it. So this is the moment the "it will not travel
  // whole" warning is both true and still actionable.
  const tooBig = deliveryWarning(sealed, folder);
  if (tooBig) process.stdout.write(`\n${tooBig}`);
}

/**
 * A path where handoff genuinely could not do its job: say what it looked for, say plainly that
 * Nothing was written, say how to fix it, and leave a non-zero exit code behind.
 *
 * The silence is the bug. Printing a soft note and exiting 0 is why a slug-matching bug ran 19
 * times undetected in one repo: the agent read "no session transcript" as a normal outcome,
 * assumed the CLI had worked, and hand-wrote a payload under delulu's letterhead — no verified
 * STATE, no verbatim user block, delulu's name on it. Degrade-open still holds everywhere else;
 * this is only for "there is no handoff at all".
 */
/** Room kept for the "+N more — see context.md" line, so saying what was left out never itself
 *  pushes the pointers block past its share. */
const MORE_TAIL_RESERVE = 60;

/**
 * A payload that is too big to travel — said at the moment it is SEALED, not two days later.
 *
 * `resume` hands the whole payload over in one Bash stdout, and the harness silently replaces any
 * Bash output above ~30,000 bytes with a 2KB preview (see `SAFE_DELIVERY_BYTES` in payload.ts).
 * resume now defends itself: it drops its least-critical blocks and names them at the top. But the
 * only person who can make the handoff fit is the one writing it, and they are here, now, with the
 * session still in their head — by the time the trim notice appears they are a fresh session that
 * has never seen this material and cannot judge what to cut.
 *
 * So this is a heads-up, not a gate: nothing is blocked, nothing is rewritten, the file on disk is
 * complete either way. Blocking would be worse than the bug — a sealed handoff nobody can read
 * beats no handoff at all, and delulu does not manufacture obstacles.
 */
function deliveryWarning(payload: string, folder: string): string {
  const n = deliveryBytes(payload);
  if (n <= SAFE_PAYLOAD_BYTES) return '';
  return `delulu handoff — HEADS-UP: this payload is ${n.toLocaleString('en-US')} bytes, over the ${SAFE_PAYLOAD_BYTES.toLocaleString('en-US')} that fits through a single \`delulu resume\` output (the harness replaces Bash output above ~${BASH_OUTPUT_CLIFF.toLocaleString('en-US')} bytes with a 2KB preview — no error, exit 0).\n`
    + `  NOTHING is lost on disk: .delulu-handoff/${folder}/payload.md is complete. But resume will deliver it TRIMMED — it drops the least critical blocks, in this order (${DELIVERY_DROP_ORDER.join(' -> ')}), names every one it dropped at the TOP of its output, and tells the next session to Read the file for the rest.\n`
    + shareAdvice(payload)
    + `  To make it arrive whole, shorten the prose blocks now, while you still remember what matters.\n`;
}

/**
 * How much room the interview has, said BEFORE it is spent.
 *
 * `deliveryWarning` fires only once the payload is already too big, and its own comment concedes
 * the draft is mostly placeholders so it "rarely fires here". That is the whole gap: at draft time
 * the budget is almost never breached, so nothing is printed, and the agent then writes five prose
 * sections with no idea how much room it has. By the time the seal reports the real size the prose
 * is written and the person who could have shortened it is being asked to go back over it.
 *
 * Measured across 34 delulu-written payloads in 9 repositories, 3 came in over the delivery budget
 * — 27,276, 30,630 and 31,683 bytes, the last written before the budget constant existed. None is a
 * mis-tuned constant. `SAFE_PAYLOAD_BYTES` sizes the blocks DELULU writes; the agent's half was
 * never given a number at all.
 *
 * The placeholders are subtracted because they are replaced, not added to — counting them would
 * understate the room by roughly a kilobyte and make the budget read as tighter than it is.
 *
 * The `room <= 0` return below is DEFENSIVE and is not reachable from the draft site today: every
 * engine-written block is capped by `BLOCK_SHARES`, so a draft cannot breach the budget no matter
 * how long the session — 48KB of user messages still produced 8,332 engine bytes. Two tests were
 * written for that branch and BOTH passed with the guard removed, because no fixture reaches it.
 * They were deleted rather than kept as decoration. If a block ever stops being share-capped, this
 * is what keeps `deliveryWarning` from being contradicted by a second notice quoting a different
 * number about the same payload.
 */
function proseBudget(payload: string): string {
  const placeholders = payload.match(/<!-- delulu:fill[\s\S]*?-->/g) ?? [];
  if (!placeholders.length) return '';
  const freed = placeholders.reduce((n, p) => n + deliveryBytes(p), 0);
  const fixed = deliveryBytes(payload) - freed;
  const room = SAFE_PAYLOAD_BYTES - fixed;
  // Already over before a word of prose is written — deliveryWarning says so with the drop order
  // and the per-block shares, and two notices disagreeing about the same number is worse than one.
  if (room <= 0) return '';
  return `delulu handoff — the ${placeholders.length} section(s) you are about to write share `
    + `${room.toLocaleString('en-US')} bytes before \`delulu resume\` has to trim this handoff to deliver it `
    + `(${fixed.toLocaleString('en-US')} of the ${SAFE_PAYLOAD_BYTES.toLocaleString('en-US')} budget is already spent on the blocks delulu wrote).\n`
    + `  That is a budget, not a target: a shorter handoff that arrives whole beats a fuller one that arrives trimmed.\n`;
}

/**
 * WHICH blocks to shorten, named with their numbers — the difference between a warning and advice.
 *
 * `deliveryWarning` above has always said a payload is too big and never said what to do about it,
 * which leaves the one person who could fix it guessing at which of ten blocks to cut. `shareReport`
 * answers that from the per-block table, and stays quiet whenever the payload fits — so this adds
 * nothing at all to the common case.
 *
 * Two blocks are named on the handoff that prompted this: the user's own words at 10,199 bytes
 * against 8,000, and the pointers block at 2,815 against 600 while duplicating gists that already
 * live in context.md. The second is the easy cut, which is exactly why the report names everything
 * meaningfully over rather than only the largest.
 */
function shareAdvice(payload: string): string {
  const over = shareReport(payload);
  if (!over.length) return '';
  const lines = over.map((o) =>
    `    ${o.name} — ${o.bytes.toLocaleString('en-US')} bytes, ${(o.bytes - o.share).toLocaleString('en-US')} over its ${o.share.toLocaleString('en-US')} share\n`);
  return `  The blocks carrying more than their share of the budget, biggest first:\n${lines.join('')}`;
}

/**
 * Did the two blocks come out sorted the way the words on the lines read? — asked at SEAL time.
 *
 * The engine pre-sorts what it CARRIES, but this session's own rulings do not exist until the
 * interview writes them, which is after the draft. That would leave the sort to unaided agent
 * judgement, which is the thing already proven not to work. `--restate` is the last moment anything
 * can change and the last moment the user is in the room, so the check runs here.
 *
 * A QUESTION, never a finding, and never a rewrite: the user owns which rules outlive their
 * session, and an engine that silently promoted a line would re-introduce the same failure from the
 * other side — a permanent rule nobody chose.
 */
function sortingNotice(payload: string): string {
  const asks: string[] = [];
  const inHolds = (name: string) => headingRe(SECTION.holds).test(`## ${name}`);
  for (const e of decidedEntries(payload)) {
    if (!e.text.trim()) continue;
    // No `from` argument: the block a line is already in must not be allowed to justify itself, or
    // this check could only ever agree with the sort it is checking.
    const reads = classifyRuling(e.text);
    if (!inHolds(e.section) && reads === 'rules')
      asks.push(`under "${e.section}", but reads as a standing rule (or has already survived a session) — should it be under "${SECTION.holds}", where it gets carried? "${clip(e.text, 110)}"`);
    else if (inHolds(e.section) && reads === 'session')
      asks.push(`under "${SECTION.holds}", but it names one file, path or commit, which usually means it is spent — still standing? "${clip(e.text, 110)}"`);
  }
  if (!asks.length) return '';
  const SHOWN = 5;
  const shown = asks.slice(0, SHOWN).map((a) => `  ? ${a}`);
  if (asks.length > SHOWN) shown.push(`  _(+${asks.length - SHOWN} more of the same)_`);
  return `delulu — ${asks.length} line(s) may be in the wrong block. delulu sorts by the words on the line and you sorted differently; you may well be right, so this is a question, not a finding — nothing was moved:\n${shown.join('\n')}\n`;
}

function failed(message: string): void {
  process.stdout.write(`delulu handoff — ${message}\n`);
  process.exitCode = 1;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ('help' in parsed) {
    process.stdout.write(`delulu handoff — capture this session into .delulu-handoff/<timestamp>/\n\n`
      + `  handoff                        capture the session you are in now\n`
      + `  handoff --restate <timestamp>  re-read the checked blocks into a handoff you already drafted\n`
      + `  handoff --name "short name"    name a handoff, with --restate <timestamp>\n`
      + `  handoff --repo <path>          work on a repo other than the current directory\n`
      + `  handoff --log <path.jsonl>     use this transcript instead of looking one up\n`);
    return;
  }
  if ('error' in parsed) {
    failed(`${parsed.error}. Nothing was written. Re-run with a value, e.g. \`--repo <path>\` or \`--restate <timestamp>\`.`);
    return;
  }
  const args = parsed;
  let repo: string;
  try {
    repo = repoKey(args.repo ?? process.cwd());
  } catch {
    failed(`not a readable path: \`${args.repo ?? process.cwd()}\`. Nothing was written — no handoff exists. Re-run from inside the repo, or pass \`--repo <path>\`.`);
    return;
  }
  // Read BEFORE any artifact is written, so every path that redacts already knows which single
  // address it is allowed to keep. Unset or unreadable means redact them all.
  setOwnEmail(git(repo, ['config', 'user.email']));

  const log = args.log ?? resolveLog(repo, args.repo ?? process.cwd());

  // `--restate <ts> --name "x"` used to name and RETURN, silently discarding the `--restate` it was
  // handed. That is the exact command `commands/handoff.md` presents as the sealing step, so anyone
  // compressing the two documented commands into the one that carries both flags got a handoff
  // whose verified zone was still draft-time: the interview's own messages never reached "What you
  // said", and no citation check ever ran. Nothing warned. A flag whose value is silently ignored
  // is the same defect as a flag whose value is silently defaulted, which this file spends
  // seventeen lines elsewhere refusing to allow.
  //
  // Restating is a re-read, so doing it before naming is safe to repeat and correct to repeat.
  // Naming still works with no transcript at all, which is why it is not gated on one: renaming a
  // sealed handoff days later from another terminal has to keep working.
  if (args.name !== undefined) {
    if (args.restate && log && existsSync(log)) restate(repo, log, args.restate);
    nameHandoff(repo, args.restate ?? '', args.name);
    return;
  }

  if (!log || !existsSync(log)) {
    const cause = args.log
      ? `the \`--log\` path \`${args.log}\` does not exist`
      : `no session transcript resolved for \`${repo}\` (looked under ${projectsDir()}/ for that repo)`;
    failed(`${cause}. Nothing was written — no handoff folder, nothing read from the repo, and none of your own words captured. Run it again with \`--log <path to this session's .jsonl>\`. Please don't write a payload by hand in its place: a file that looks checked but isn't is the one failure delulu exists to prevent.`);
    return;
  }

  if (args.restate) { restate(repo, log, args.restate); return; }

  // A session where the user never spoke cannot be handed off — there is no thread to continue,
  // and IN YOUR WORDS, the block that makes this a continuation rather than a briefing, would be
  // absent entirely. Writing the folder anyway is worse than doing nothing: `resume` loads the
  // NEWEST folder, so a contentless capture SHADOWS the real handoff sitting beside it and serves
  // a blank page with no error. Observed live — a fresh session that ran `handoff` instead of
  // `resume` produced `userLines: []` and took over the pointer from a complete handoff written
  // two minutes earlier. Refusing costs nothing; the real handoff stays reachable.
  // Deliberately NOT "the IN YOUR WORDS block came out empty" — that also happens to a real session
  // whose only typed line was a boilerplate opener, and refusing there would throw away hours of
  // genuine work. Only a session with no user prose AND no answers is refused.
  if (!hasAnyUserInput(log)) {
    failed(`${readable(log) ? 'this session has no user messages yet' : 'that transcript could not be read'} (\`${log}\`), so there is nothing to hand off. Nothing was written — any earlier handoff for this repo is untouched and still the one \`delulu resume\` will load. If you meant to continue a previous session, run \`delulu resume\`.`);
    return;
  }

  const ts = stamp();
  // Folder name is the timestamp; guard the rare same-second collision so two handoffs never
  // overwrite each other. The library keeps the newest 15 plus every unfinished draft (see
  // `pruneHandoffs`) — reloadable any time; older finished ones are pruned to bound the folder.
  let folder = ts;
  let dir = join(repo, '.delulu-handoff', folder);
  // The name is CLAIMED further down by mkdir, not decided here. This loop used to settle the
  // folder by `existsSync`, and the actual creation used `recursive: true`, which does not fail on
  // a directory that already exists. Two captures started in the same second therefore agreed on
  // the same name and both wrote into it: measured over three trials, two concurrent captures
  // produced ONE folder every time, whose payload could come from one session while citations.json
  // came from the other — the verification substrate belonging to a different conversation than the
  // words it is supposed to verify, with nothing said about it at either end.
  // 0700/0600 throughout: these artifacts hold the user's whole session, and Claude Code keeps
  // the transcript they came from at 0600. Writing them world-readable widened the exposure of
  // the very thing it copied — on a shared machine another local account could read the payload
  // while being unable to read its source.
  // STATE is captured BEFORE delulu writes ANYTHING — before the handoff folder as well as before
  // .gitignore. Capturing after `mkdirSync` meant that on the first run in a repo (the run that
  // adds the ignore line) `.delulu-handoff/` was untracked and counted as one of the user's
  // uncommitted entries, in the block that exists to tell them what THEY changed. It went unseen
  // because the test guarding it ran in a plain temp directory where `git status` fails outright.
  const pointers = subagentPointers(log);
  const verifiedBody = buildVerifiedBody(log, repo, pointers);

  // Claim the folder ATOMICALLY. A non-recursive mkdir fails with EEXIST if anybody got there
  // first, which is the only way to tell "I created this" from "it was already here" without a
  // race between the two. The parent is created separately and may well already exist.
  mkdirSync(join(repo, '.delulu-handoff'), { recursive: true, mode: 0o700 });
  for (let n = 2; ; n++) {
    try { mkdirSync(dir, { mode: 0o700 }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      folder = `${ts}-${n}`;
      dir = join(repo, '.delulu-handoff', folder);
    }
  }
  const ignoreWarn = ensureGitignored(repo);
  const digest = buildSubagentDigest(pointers);
  // index.md — the deterministic, on-demand navigation map of the prior session (line-refs into
  // the raw transcript). Lets a fresh session retrieve any prior detail VERBATIM without reloading
  // the whole thing — and is the verifiable backstop behind the (unverified) THREAD/Decisions.
  const indexMap = buildTranscriptIndex(log);
  const rawTranscript = `${log.replace(homedir(), '~')}`;
  if (indexMap) {
    writeFileSync(join(dir, 'index.md'), `# Prior-session map — ${basename(repo)} · ${ts}

> Each line is an anchor with its line number in the raw transcript. To recover any prior detail VERBATIM — a decision's reasoning, what was said around a turn — Read around that \`L<n>\` in the raw transcript (don't reload the whole session). **Transcript events are LARGE (inline tool I/O + reasoning) — Read a SMALL window (a few lines via offset+limit) around the line, not 30+, or you'll blow the read limit.** Raw transcript: \`${rawTranscript}\`

${indexMap}
`, { mode: 0o600 });
  }

  // Built here rather than inline in the template, because the gists below are budgeted against
  // what these lines already spend. The pointers are the block's whole reason to exist — losing
  // them costs access to everything delulu wrote to disk — so they are costed first and in full.
  //
  // context.md is named only when it HOLDS something. On a session with no subagents that file
  // contains one line saying so, and pointing at it spends the next agent's context on a read that
  // returns nothing — while telling it there is depth here that there is not. Most sessions dispatch
  // no subagents, so this was the common case, not the edge one.
  const pointerLines = [
    indexMap ? `- \`.delulu-handoff/${folder}/index.md\` — map of the prior session (line-refs); to recover ANY detail verbatim, Read the raw transcript around that line instead of reloading it all` : '',
    digest.length ? `- \`.delulu-handoff/${folder}/context.md\` — each subagent's full verbatim finding` : '',
  ].filter(Boolean).join('\n');
  // Tier 1 (always in payload): a short verbatim gist per subagent WITH a finding — it travels with
  // the always-loaded payload so resume carries it without opening anything. Soft-capped so the
  // always-loaded tier stays tiny even with many subagents; context.md keeps ALL of them, verbatim.
  const withFindings = digest.filter((d) => d.finding);
  // FIT TO THE SHARE, not to a count. This was `slice(0, 12)`, and twelve 160-character gists plus
  // their filenames run to roughly 2,300 bytes — which is why this block, the one that holds the
  // POINTERS to context.md and index.md, still runs over its share in three of the eight completed
  // handoffs in this repo (measured 2026-09-07) and ran over in most of them before the fix and was the first thing the delivery trim threw away. The gists duplicate context.md; the
  // pointers are the only way to reach it. So the pointers are costed first and the gists get
  // whatever the share has left, which is a real number on a short session and nearly nothing on a
  // long one — degrading instead of blowing the budget.
  const gistHeader = '\n\n**Subagent findings this session** (gist — full verbatim in `context.md`):\n';
  const gistRoom = BLOCK_SHARES[SECTION.more] - deliveryBytes(pointerLines + gistHeader) - MORE_TAIL_RESERVE;
  const shownGists: typeof withFindings = [];
  let gistSpent = 0;
  for (const d of withFindings) {
    const line = `- \`${d.file}\`: "${clip(d.finding, 160)}"\n`;
    if (gistSpent + deliveryBytes(line) > gistRoom) break;
    gistSpent += deliveryBytes(line);
    shownGists.push(d);
  }
  const subagentGists = shownGists.length
    ? gistHeader
      + shownGists.map((d) => `- \`${d.file}\`: "${clip(d.finding, 160)}"`).join('\n')
      + (withFindings.length > shownGists.length ? `\n- _(+${withFindings.length - shownGists.length} more — see context.md)_` : '')
    : '';


  // Carrying a decision forward stops depending on the agent remembering to: the engine puts the
  // previous handoff's rulings into the draft, already addressed to the session that holds them.
  // Deliberately parked OUTSIDE the DECIDED section — `decidedLines` grades EVERY content line
  // under that header, so ref-bearing candidates sitting there would be graded as this session's
  // own decisions and reported against a transcript they were never in.
  const carried = carriedCandidates(join(repo, '.delulu-handoff'), folder);
  // The ceiling bounds what is SHOWN, and it can never reach a STANDING RULE.
  //
  // `carried.lines` already sorts durable-first, so a plain `slice(0, CARRIED_CAP)` protected the
  // rules only for as long as there were fewer than thirty of them. That was described as a size
  // "a real session never reaches" and it is now 29, having grown by four in a single session —
  // rules accumulate by design and only the user removes one, so the count goes one way. The next
  // capture would offer 38 candidates against a ceiling of 30.
  //
  // Truncation there is not silent: the overflow line says how many were left out, and the drop
  // check reads the uncapped set so nothing hidden is reported as lost. But an agent cannot promote
  // a rule it was never shown, and being told afterwards that it dropped one is a worse outcome
  // than a slightly longer comment. So the rules are all shown, always, and the ceiling applies to
  // what is left — which is where an unbounded library would actually come from.
  const all = carried ? carried.lines : [];
  const durable = all.filter((l) => l.life === 'rules');
  const rest = all.filter((l) => l.life !== 'rules');
  const shown = [...durable, ...rest.slice(0, Math.max(0, CARRIED_CAP - durable.length))];
  const overflow = all.length - shown.length;
  const of = (life: Lifetime): string[] => shown.filter((l) => l.life === life).map((l) => l.text);
  // An emitted line can contain `-->` only if the user typed one; escaping it here is what stops a
  // quoted arrow closing delulu's own comment early and spilling the rest of the block into the
  // payload as if the agent had written it.
  const group = (lines: string[], lead: string): string =>
    lines.length ? `\n     ${lead}\n${lines.map((l) => `       ${l.replace(/--+>/g, '--&gt;')}`).join('\n')}\n` : '';
  const carriedBlock = carried
    ? `
<!-- delulu:fill — ${CARRIED_MARKER}: what the USER locked in \`${carried.stamp}\`, emitted by the
     engine and already session-qualified. These are NOT part of this handoff yet.
     ASK ONE QUESTION OF EVERY LINE, BEFORE ANY OTHER: could this be BUILT IN instead? Carrying is
     not the default. A rule a test or a command file already enforces is being re-read every
     session for behaviour that cannot go wrong. A rule the user has restated more than once is a
     rule that should have become a check. And most of what reaches this block was direction given
     in the moment, spent the moment it was acted on. A constraint is either built into the tool or
     it was steering; carried text that enforces nothing is the third thing, and it is what this
     block exists to stop.
     So each line goes to exactly one of four places, and only the last keeps it here:
       ALREADY ENFORCED -> drop it, and name the test or command file that holds it.
       COULD BE A CHECK -> drop it, and write the check. That is the real work, not the sorting.
       WAS STEERING     -> drop it. It did its job when it was said.
       CANNOT BE EITHER -> keep it, and say WHY on the line itself:
                           \`- <rule>. \\\`ref\\\`: "their words" — ${CARRY_REASON_MARKER} <why>\`
     A line kept with no such reason is NAMED at the seal. Judgement about risk and preference about
     taste are the honest cases; "it feels important" is not one.
     Take the sort to the user — delulu's grouping below is read off the words and is a GUESS.
     Copy a kept line VERBATIM, ref and quote intact.
     NEVER re-point one of these refs at a line in THIS transcript. That line holds a different
     sentence, and the check reports it as a fabrication — which is exactly why carried constraints
     used to be dropped rather than restated.
     Nothing here expires on its own, and only the user retires one. Name what you dropped, and why,
     under "${SECTION.read}" — an empty block is a true statement, not an unfinished one.
     Delete this whole block once you have been through it.
${group(of('rules'), `STILL HOLDS -> "${SECTION.holds}" (survived a session, or reads as a standing rule):`)}${group(of('unsorted'), `NO SIGNAL -> ask which block it belongs in. If no answer comes, put it under "${SECTION.decided}", exactly as it would have gone before the two blocks existed:`)}${group(of('session'), `PROBABLY SPENT -> "${SECTION.decided}" only if it is still live; otherwise drop it (it names one file, path or commit):`)}${overflow ? `
     _(+${overflow} older decision(s) from that handoff not shown — read its rulings
     in full at .delulu-handoff/${carried.stamp}/payload.md before assuming this is all of them.)_` : ''}
-->`
    : '';

  // payload.md — short, self-sufficient. The agent fills the marked sections via the
  // /delulu:handoff interview. Everything above the fence is engine-verified and final.
  const payload = `# delulu handoff — ${basename(repo)} · ${ts}

## ${SECTION.state} — read from the real repo and disk when this was captured
${verifiedBody}

---
> **Everything below this line is the last session's agent writing from memory, and delulu could not check any of it.** What is above the line it can prove: it read the repo and the disk, and it quoted you word for word. What is below is a colleague's handwritten note — worth reading, not worth trusting on its own. Before you act on anything that matters, and especially on "committed", "pushed", "done" or "tests pass", check it against what delulu actually read above.
${carriedBlock}
## ${SECTION.holds}
<!-- delulu:fill — the rules that OUTLIVE this session: what the user has locked and has NOT
     revoked. This block is carried forward; the one further down is not. That is the whole
     difference between them, and it is the difference this file kept losing.
     Same evidence standard as "${SECTION.decided}" — one per line, each ending with the \`L<n>\`
     ref from "${SECTION.said}" where they said it, followed by their own words. A rule locked in
     an EARLIER session keeps its ORIGINAL ref, session-qualified as \`<handoff-stamp>:L<n>\`;
     re-pointing it at a line in this transcript is reported as a fabrication.
     A line belongs HERE when it is still in force with no end in sight — "always", "never",
     "before any". A directive about one file, one commit or one task belongs BELOW, in
     "${SECTION.decided}", where it is MEANT to die at the session boundary.
     Nothing here ages out and nothing expires quietly: a rule leaves only when the user revokes
     it, and you may not retire one on your own. If they do revoke one, drop the line and say
     which, and why, under "${SECTION.read}".
     Leave this block EMPTY if nothing stands yet. An empty rules block is a true statement and
     delulu reads it as one — it is NOT counted as an unfinished section. Inventing a rule to fill
     it is the worst thing you can do here: it will arrive in every later session wearing a
     citation, which reads as MORE settled than a fresh judgement precisely because it has one. -->

## ${SECTION.thread}
<!-- delulu:fill — INTERPRET the verbatim "${SECTION.said}" block above: what the unfinished thought actually is and why it matters, the intent behind those words. Anchor to the quotes; do NOT re-paraphrase them. Write it so the next session opens MID-CONVERSATION, not mid-report. -->

## ${SECTION.elseWrong}
<!-- delulu:fill — IF a "${SECTION.broke}" block appears above, it holds the main agent's tool errors,
     clipped to 220 chars and capped at 12; do not restate those. It is ABSENT when nothing
     errored, and it NEVER includes subagent errors. Everything else belongs here: an approach
     that ran without erroring but was wrong, a wrong assumption, a dead end the user vetoed,
     a subagent's failure, and WHY. -->

## ${SECTION.decided}
<!-- delulu:fill — decisions that are SPENT when this session ends: a call about one file, one
     commit, one task. This block is NOT carried forward — if a line here would still be true in a
     month, it belongs in "${SECTION.holds}" above instead, and putting it here is how a standing
     rule quietly disappears.
     ONE decision per line. Each line ends with the \`L<n>\` line-ref from
     "${SECTION.said}" where the user actually said it, FOLLOWED BY THEIR OWN WORDS from that line:
       "- Free models only, never a paid API. \`L<n>\`: "i dont want a paid api""
     Quote them verbatim — a few words is enough, and it must be text that really appears there.
     A line without a citation does NOT belong here — put it under "${SECTION.read}" below.
     PREFER WORDS THEY TYPED. A pick of an option YOU wrote and marked "(Recommended)" is the
     weakest proof there is — you would be quoting yourself — and delulu now reports it as such
     rather than as a ruling. If that pick is genuinely all there is, say so in the line.
     CARRYING ONE FORWARD from an earlier handoff: keep its ORIGINAL ref, session-qualified as
     \`<handoff-stamp>:L<n>\` (the stamp heading that handoff), never re-pointed at a line in this
     session. A constraint the user locked two sessions ago is still locked; re-citing it to the
     wrong transcript is what used to make carried decisions read as fabrications and vanish.
     delulu re-checks this at finalize AND at resume, and shows the user any line that cites a
     place they never spoke, quotes words they did not say there, or cites nothing at all.
     What it CANNOT check is whether your summary in front of the quote is a fair reading of it —
     so the quote must carry the decision, not just sit next to it. -->

## ${SECTION.read}
<!-- delulu:fill — what the agent inferred, concluded, or decided on its own. Useful, but the user
     never said it. Cross-check before acting on any of it; never carry it forward as a ruling. -->

## ${SECTION.next}
<!-- delulu:fill — exactly ONE action, with a SEARCHABLE ANCHOR (the function or exact string to grep for, never file:line — line numbers rot), plus the REASON it is first. Not a list.
     A handed-forward task list is the shortest-lived thing in a handoff: it is usually stale on
     arrival and it anchors the next session to a plan the user may already have moved past. The
     reason matters more than the task — a successor who knows WHY can re-decide WHAT.
     Anything else that still needs doing belongs in "${SECTION.thread}", as part of where the conversation
     actually stands — not as a second task list down here. -->


## ${SECTION.more}
${pointerLines}${subagentGists}

---
${CLOSER}. Ask me about anything that's missing before you get going.
`;
  writeFileSync(join(dir, 'payload.md'), payload, { mode: 0o600 });

  // context.md — the deep half. STATE is NOT duplicated here (it lives + refreshes in payload.md; a
  // copy would silently go stale on --restate). Each subagent's final finding is written VERBATIM by
  // the engine (zero model) — the agent no longer reads + paraphrases raw transcripts, which is the
  // handoff-time token win. The finding is faithful; the subagent's own claims are still unverified.
  const findingsBlock = digest.length
    ? digest.map((d) =>
        `### \`${d.file}\`${d.finding ? ' — verbatim final result' : ''}\n${d.finding ? redact(d.finding.trim()) : '(no final result captured — read the raw transcript)'}\n\n_Raw transcript (for the full reasoning, Read a small window): \`${d.pointer.replace(homedir(), '~')}\`_`,
      ).join('\n\n')
    : '- (no subagents this session)';
  const context = `# Full session context — ${basename(repo)} · ${ts}

> Engine-verified STATE + your verbatim words live in \`payload.md\` (refreshed at finalize). Below is each subagent's final result, **verbatim** (engine-extracted, NOT re-paraphrased) — the extraction can't fabricate, but a subagent's own claims are unverified, so cross-check load-bearing ones against STATE or the raw transcript. Open this file only when the payload isn't enough.

## ${SECTION.subagents}
${findingsBlock}
`;
  writeFileSync(join(dir, 'context.md'), context, { mode: 0o600 });

  // The citation record travels with the handoff: it is what lets a FRESH session check, months
  // later, whether a "locked decision" traces back to something the user actually said.
  writeCitations(dir, log);

  // The PENDING marker is GONE, per the user's ruling at `L906` ("Delete the marker and its
  // comments"). It was the last unguarded write in the capture, and it sat AFTER every real
  // artifact: a throw there — PENDING existing as a directory, or root-owned from a `sudo` run —
  // reported a fully successful capture as "could not capture", exit 1, and skipped prune forever.
  // It was also the one artifact written without a mode, so under a permissive umask it landed
  // world-writable beside four 0600 files. Nothing loaded it: `resume` picks the newest FOLDER.
  // Deleting it removes the false-failure path, the permission hole, and the branch where `resume`
  // cleared the nudge before it knew the payload was even readable.

  // Prune AFTER this handoff is fully on disk, so a failure above can never cost you old ones.
  const pruned = pruneHandoffs(join(repo, '.delulu-handoff'), folder);
  if (pruned) process.stdout.write(pruned);

  if (ignoreWarn) process.stdout.write(ignoreWarn);
  // Only the STATE lines are echoed, not the whole verified body.
  //
  // Everything printed here is ALSO written to payload.md, which the interview must open to edit.
  // Echoing the full body therefore put the same bytes through the session's context twice, and
  // three times once `--restate` printed its merged block as well. Measured on a 60-message
  // session that is 7,614 bytes (~1,900 tokens) duplicated per echo — spent at the end of a
  // session, in a window that is nearly full, to save context in the next one, which is empty.
  // Paying it twice at the scarcest moment is the opposite of what this tool is for.
  //
  // STATE stays because it is three lines, it is what a human wants to see in the terminal, and it
  // is the one part the agent may reasonably act on before opening the file. The rest is named,
  // sized and left where it lives.
  const stateOnly = verifiedBody.slice(0, verifiedBody.indexOf(`\n## ${SECTION.said}`) + 1 || undefined).trimEnd();
  const restBytes = deliveryBytes(verifiedBody) - deliveryBytes(stateOnly);
  process.stdout.write(`delulu read the repo and your messages, and wrote the draft:\n  ${join('.delulu-handoff', folder, 'payload.md')}\n\n${stateOnly}\n\nYour own messages and the tool errors are in that file too (${restBytes.toLocaleString('en-US')} more bytes), already checked — open it when you fill the interview in, and do not re-read them here.\n\nWhat's left is the interview — the agent fills in where you left off, what you decided, what went wrong and where to start. After that it's ready to pick up with \`delulu resume\` in a fresh session.\n`);
  // A draft is mostly placeholders, so this rarely fires here — but IN YOUR WORDS is engine-written
  // and can be 10KB on its own, and a draft already over the line can only get worse once the
  // interview fills five more sections. Saying it now costs one line; the seal says it again with
  // the final size, because that is the number that decides.
  const tooBig = deliveryWarning(payload, folder);
  if (tooBig) process.stdout.write(`\n${tooBig}`);
  else {
    const room = proseBudget(payload);
    if (room) process.stdout.write(`\n${room}`);
  }
}

try {
  // Only when this file IS the program. Importing it for a symbol used to run a whole capture —
  // see `isProgram`, which degrades OPEN so a guard failure can never silence the CLI.
  if (isProgram(import.meta.url)) main();
} catch (e) {
  // Crashing out of main() means no handoff was produced. Exit 0 here made that indistinguishable
  // from success for anything reading the code instead of the prose.
  // Report what actually reached disk. Asserting "Nothing was written" while a complete handoff sat
  // there was the worst possible lie from this line: that sentence exists to stop an agent
  // hand-writing a payload under delulu's letterhead, and here it CAUSED that, because the agent was
  // told nothing existed while a real handoff was on disk and prune had never run.
  let written = '';
  try {
    // The --repo TARGET, not the cwd: naming a different repo's handoff told the agent capture had
    // probably worked when nothing was written here at all.
    // lastIndexOf, matching parseArgs, which assigns on every occurrence. indexOf took the FIRST
    // --repo while the capture used the LAST, so a duplicated flag made this look at a different
    // repo and print "Nothing was written" over a real handoff.
    const i = process.argv.lastIndexOf('--repo');
    const target = i >= 0 ? process.argv[i + 1] : process.cwd();
    const base = join(repoKey(target), '.delulu-handoff');
    const newest = readdirSync(base)
      .filter((f) => existsSync(join(base, f, 'payload.md')))
      .sort()
      .pop();
    if (newest) written = ` A handoff folder DOES exist at .delulu-handoff/${newest} — check it before assuming nothing was captured; it may be complete.`;
  } catch { /* no folder, or unreadable — then nothing was written after all */ }
  process.stdout.write(`delulu handoff — could not capture: ${e instanceof Error ? e.message : 'unknown'}.${written || ' Nothing was written — no handoff exists for this session.'}\n`);
  process.exitCode = 1;
}
