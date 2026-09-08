// delulu resume — in a fresh session, load a session handoff so the agent continues
// where it left off. NON-DESTRUCTIVE + repeatable: handoffs are a persistent, gitignored
// library you can reload anytime, any day, as many times as you like.
//   delulu resume          -> the LATEST handoff
//   delulu resume <ts>      -> a specific handoff (prefix match, e.g. `2026-06-16`)
//   delulu resume --list    -> browse every handoff for this project
//
// Loading is folder-based and never deletes anything, so an accidental resume in the wrong
// session does no harm. (The PENDING nudge marker is gone; a leftover one is swept up on load.)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoKey } from '../engine';
import { gitEnv } from '../engine/git-env';
import { namesSameRepoFile } from '../engine/repo-files';
import { isProgram } from './entry';
import { stampWhen, handoffLabel, nameCarriedRefs, nameTitle } from './handoff-name';
import { checkCitations, citationItems, carriedLookup, parseCitationRecord } from './citations';
import { carryItems, droppedCarried } from './carry';
import type { CitationRecord } from './citations';
import {
  AGENT_ZONE, BASH_OUTPUT_CLIFF, CLOSER, DELIVERY_DROP_ORDER, SAFE_DELIVERY_BYTES, SECTION,
  deliveryBytes, headingsFor, isIncompletePayload, namedBlocks, payloadProblem, rulingBlockNames, rulingHeadings, sectionOf
} from './payload';

interface Args { repo?: string; pick?: string; list?: boolean; }

/**
 * `--repo` with no value used to fall back to the current directory. An agent ran exactly that and
 * operated on the real repo instead of its temp one, deleting a marker there. A missing value is an
 * error, not a default.
 */
function parseArgs(argv: string[]): Args | { error: string } {
  const a: Args = {};
  const picks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // An unknown flag is an ERROR, matching `handoff`. Only the exact tokens matched, so anything
    // else beginning `--` hit neither branch and was silently dropped: `--repo=/other/repo` meant
    // "the current directory", and a typo like `--lst` loaded and dumped a whole payload instead of
    // listing. The header comment above describes this incident as fixed — it was fixed in the
    // other CLI. Same door, same house, one of them locked.
    // ANY leading dash, not just `--`. `handoff` has rejected single-dash tokens since `-h` fell
    // through and ran a whole capture; resume kept the narrower guard, so `-h` and `-repo /etc`
    // were not refused — they were quietly reinterpreted as the NAME of a handoff to search for,
    // and reported back as "no handoff matching `-repo /etc`". Same door, same house, and this is
    // the half that was still unlocked.
    if (arg.startsWith('-') && arg !== '--repo' && arg !== '--list')
      return { error: `unknown flag \`${arg}\`` };
    if (arg === '--repo') {
      const v = argv[i + 1];
      // `v === ''` matters as much as `v === undefined`: `realpathSync('')` returns the CURRENT
      // DIRECTORY, so `--repo "$UNSET_VAR"` from a script silently retargeted the real repo — the
      // same footgun this guard was written for, one shape further along.
      if (v === undefined || v === '' || v.startsWith('--')) return { error: '`--repo` needs a value' };
      a.repo = v;
      i++;
    } else if (arg === '--list' || arg === 'list') a.list = true;
    // EVERY bare word is kept, not just the first. `$ARGUMENTS` reaches this unquoted, so the
    // shell has already split the name the user typed: `resume dead weight, live bugs` arrives as
    // four argv entries and `!a.pick` threw away three of them. The survivor still substring-
    // matched, so the command appeared to work while silently searching for something the user did
    // not ask for — and the more specific they were, the more of their words were discarded.
    // Rejoining with a single space is what the label match wants: strictly narrower than the first
    // word alone, so it can only reduce the "N handoffs match" case, never widen it.
    else if (!arg.startsWith('--')) picks.push(arg);
  }
  if (picks.length) a.pick = picks.join(' ');
  return a;
}

interface Handoff { ts: string; payload: string; }

/** Every handoff folder for this repo, newest first (ISO timestamps sort chronologically). */
function listHandoffs(base: string): Handoff[] {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((f) => {
      try { return statSync(join(base, f)).isDirectory() && existsSync(join(base, f, 'payload.md')); }
      catch { return false; }
    })
    .sort()
    .reverse()
    .map((ts) => ({ ts, payload: join(base, ts, 'payload.md') }));
}


/** Read a payload and ask the shared predicate — one definition, shared with pruneHandoffs.
 *  What counts as incomplete, and why, is documented once at `isIncompletePayload` in payload.ts. */
function isIncomplete(payloadPath: string): boolean {
  try { return isIncompletePayload(readFileSync(payloadPath, 'utf8')); } catch { return false; }
}

/**
 * Remove a PENDING marker left by an older build. The marker itself is gone (the user's ruling at
 * `L906`), but one may still be sitting in a repo captured before this, and leaving it there means
 * a nudge that never clears. Nothing reads it — resume loads the newest FOLDER — so this is pure
 * cleanup, and it runs only once there is nothing left to go wrong afterwards.
 */
function clearStaleNudge(base: string): void {
  const pending = join(base, 'PENDING');
  if (existsSync(pending)) { try { unlinkSync(pending); } catch { /* harmless if it sticks */ } }
}


/**
 * Is the captured STATE still TRUE, or has the repo moved since?
 *
 * STATE is the half of the payload delulu can prove — but it proves it at CAPTURE time and then
 * replays it verbatim, so its truth decays the moment anyone commits. Measured on a real load:
 * a handoff sealed at `main @ 64da515 · tree clean` was resumed two days later onto a different
 * branch with an unpushed commit, and the block still asserted the old line under a heading that
 * says engine-verified. The payload TELLS the next agent to cross-check; nothing made it happen.
 *
 * So the check runs here, where it is cheap and where the answer is still actionable. This is
 * information, not an accusation: a moved repo is normal between sessions. What is not normal is
 * being told "clean `main`" while standing on a dirty branch, and committing on the strength of it.
 *
 * Best-effort and silent on failure. If git cannot be read NOW we say nothing at all — a false
 * "your repo moved" is exactly the kind of manufactured obstacle delulu does not do.
 */

/**
 * The repo-vs-notes delta, as ONE block.
 *
 * Everything here answers a single question — what is different NOW from what the notes below
 * describe — and each answer used to print as its own loose `delulu — ...` sentence. Three more
 * arrived in one day and the preamble reached 2,615 characters, which the reader pays for on every
 * resume before reaching a word of the actual handoff. Grouped, it is scannable; empty, it is gone.
 */

/**
 * Can the notes below be trusted — grouped, the same way the repo delta is.
 *
 * These printed as two more loose `delulu — ...` sentences plus a third about unfilled
 * placeholders, stacked underneath the repo block. Different question from SINCE YOU LEFT (that one
 * is "what changed"; this is "is what I am reading real"), so it stays a separate block — but it is
 * one block, and it disappears entirely when there is nothing to say, which is the common case.
 *
 * `hard` and `soft` are kept visually distinct on purpose: a line whose ADDRESS does not check out
 * is a different and far stronger claim than one whose address is real and whose quote merely could
 * not be verified. Collapsing them is how an unverifiable line came to be reported as an invented
 * one, which is a false red.
 */
/**
 * How many findings of ONE kind this block names before it stops enumerating them.
 *
 * The count in front of each list is never capped, so nothing is hidden — but the list itself was
 * one line per finding with no ceiling, and it is charged to the same delivery budget as the
 * handoff it describes. Measured: a 22,935-byte payload with 16 uncited decisions spent enough of
 * the budget naming them that the payload could not travel, and resume printed HANDOFF NOT
 * DELIVERED — a total loss where, before the budget existed, a partial payload had arrived. The
 * block explaining the handoff must never be the reason the handoff does not arrive.
 *
 * Sixteen is the size of this repo's own newest DECIDED block, so that was a real shape.
 */
const LIST_CAP = 5;

/** Enumerate up to `LIST_CAP` findings, and SAY how many were not named. Never a silent cut. */
function listCapped(items: string[], lead: string, marker: string): string[] {
  const out = items.slice(0, LIST_CAP).map((t) => `${lead}${marker} ${t}`);
  if (items.length > LIST_CAP)
    out.push(`${lead}_(+${items.length - LIST_CAP} more of the same, every one is in the payload's own DECIDED block)_`);
  return out;
}

/**
 * One object, not eight positional arguments. It was six and each new finding class added another,
 * which is how a call site ends up passing `weak` where `carried` belongs — a mistake the types
 * cannot catch, in the block whose entire job is being accurate about provenance.
 */
interface Trust {
  hard: string[]; soft: string[]; weak: string[]; carried: string[]; unrecorded: string[];
  /** Constraints the PREVIOUS handoff carried that this one does not. */
  lost: string[];
  /** The carried block was never worked through. The routine count stays at the seal — `carryItems`. */
  lostNote: string;
  unfilled: boolean;
}

function beforeYouTrust({ hard, soft, weak, carried, unrecorded, lost, lostNote, unfilled }: Trust): string {
  if (!hard.length && !soft.length && !weak.length && !carried.length && !unrecorded.length && !lost.length && !lostNote) return '';
  const out: string[] = [];
  if (hard.length) {
    out.push(`  - ${hard.length} line(s) under DECIDED cannot be traced to something you said, the agent's read, not settled:`);
    out.push(...listCapped(hard, '      ', '\u26a0'));
    // Only meaningful alongside a finding: on a handoff nobody abandoned there is no boilerplate to
    // mistake for a ruling, and saying so anyway is noise on the common path.
    if (unfilled) out.push(`      (this handoff was never finished, so the above may be delulu's OWN unfilled placeholder text, read as "unfinished", not "fabricated")`);
  }
  // Between the two, in both senses. The address holds and the quote checks out — nothing here
  // failed — and the words being quoted as the user's ruling are words the LAST AGENT wrote on a
  // button and recommended. Reporting it as untraceable would be a false accusation; reporting it
  // as unverifiable would be false the other way; saying nothing is what let it reach 9 of 16
  // decisions on the newest stored handoff.
  if (weak.length) {
    out.push(`  - ${weak.length} decision(s) rest on words the AGENT wrote, not yours, you picked its own recommendation:`);
    out.push(...listCapped(weak, '      ', '≈'));
  }
  if (soft.length) {
    out.push(`  - ${soft.length} decision quote(s) could not be checked, not evidence either way:`);
    out.push(...listCapped(soft, '      ', '\u2022'));
  }
  // WHAT IS NOT HERE. Every shelf above grades a line that IS in the payload; this one names a
  // constraint that should be and is not, which is the only failure the others structurally cannot
  // see — a dropped line leaves nothing behind to check.
  //
  // Above the ✓ deliberately: "a constraint survived" and "a constraint did not" belong together,
  // and the bad news goes first because it is the one that needs a decision.
  if (lost.length) {
    out.push(`  - ${lost.length} constraint(s) the handoff before this one carried are NOT in this one, and each said no check could hold it:`);
    out.push(...listCapped(lost, '      ', '!'));
    // The one thing delulu genuinely cannot tell, said rather than guessed at. Silence here would
    // read as "they were retired"; an accusation would read as "the last agent erred". Both are
    // claims about an intention nobody recorded.
    out.push(`      (delulu cannot tell a revocation from a slip. If the user still means these, they are still true, raise them rather than deciding either way on your own.)`);
  }
  if (lostNote) out.push(`  - ${lostNote}`);
  // The one POSITIVE line this block can print, and it is here rather than nowhere because the
  // behaviour it describes \u2014 carrying a constraint forward instead of re-litigating it \u2014 is what
  // the check used to punish. A decision that survives a session boundary and still traces to the
  // user's own words is the strongest item in the payload; it should read like it.
  out.push(...listCapped(carried, '  - ', '\u2713'));
  // LAST, and worded as an absence rather than a finding. Everything above is delulu reporting what
  // it looked at; this is delulu reporting what it could not look at, because the handoff predates
  // the check. Putting it under the same "don't hold up" header as a real finding would accuse an
  // old artifact of something, and an old artifact is not evidence of anything.
  if (unrecorded.length) {
    out.push(`  - part of the check could not RUN on this handoff, it was written by an earlier delulu:`);
    out.push(...listCapped(unrecorded, '      ', '\u25e6'));
  }
  // The header must match what is actually below it. `hard`, `soft` and `weak` are findings — a
  // line that failed a check or could not pass one. `carried` is a SUCCESS (a constraint survived a
  // session and still traces to the user's words) and `unrecorded` is an ABSENCE (nothing was
  // examined at all). Announcing "a few of these don't hold up" over nothing but those two rings an
  // alarm on the success path, which is the same class of untrue sentence this block exists to stop.
  const found = hard.length || soft.length || weak.length;
  const head = found
    ? "A few of the notes below don't hold up, delulu re-checked them just now:"
    : 'delulu re-checked the notes below just now:';
  return `${head}\n${out.join('\n')}\n`;
}
function sinceYouLeft(notes: string[]): string {
  const items = notes.filter((n) => n && n.trim());
  if (!items.length) return '';
  return `Some things moved while you were away. delulu checked the repo just now rather than taking the notes' word for it:\n`
    + items.map((n) => `  - ${n}`).join('\n') + '\n';
}
function stateDrift(repo: string, body: string): string {
  const m = body.match(/^- Branch `([^`]+)` @ `([^`]+)` · tree ([^\n]*)$/m);
  if (!m) return '';
  const [, wasBranch, wasSha, wasTree] = m;
  const now = (args: string[]): string | undefined => {
    try { return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { env: gitEnv(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return undefined; }
  };
  const branch = now(['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = now(['rev-parse', '--short', 'HEAD']);
  if (branch === undefined || sha === undefined) return '';
  const moved: string[] = [];
  if (branch !== wasBranch) moved.push(`branch \`${wasBranch}\` -> \`${branch}\``);
  if (sha !== wasSha) moved.push(`commit \`${wasSha}\` -> \`${sha}\``);
  // Only compare cleanliness when the capture actually KNEW it. A capture that recorded "unknown"
  // has nothing to disagree with, and reporting drift from an unknown is inventing a fact.
  const porcelain = now(['status', '--porcelain']);
  const wasKnown = wasTree.trim() === 'clean' || /uncommitted/.test(wasTree);
  if (porcelain !== undefined && wasKnown) {
    const wasClean = wasTree.trim() === 'clean';
    // delulu's OWN handoff folder must never count as your uncommitted work. In a repo that does
    // not gitignore `.delulu-handoff/`, writing the handoff dirties the tree, and resume would then
    // report a tree drift that delulu itself had just caused — an obstacle manufactured out of our
    // own footprint. `handoff.ts` learned this same lesson about STATE; it applies identically here.
    // `.gitignore` joins `.delulu-handoff/` in the exclusions, because `ensureGitignored` WRITES
    // that file on the first capture in any repository. Excluding only the handoff folder meant the
    // very next resume reported "tree was clean at capture, is dirty now" over delulu's own
    // footprint — invisible in this repository, whose .gitignore already carried the line, and
    // present on every first run everywhere else. Only an untracked `.gitignore` is ignored: a
    // MODIFIED one is the user's file and their change.
    const ours = (l: string): boolean => /\.delulu-handoff\//.test(l) || /^\?\?\s+\.gitignore$/.test(l.trim());
    const isClean = porcelain.split('\n').filter((l) => l.trim() && !ours(l)).length === 0;
    if (wasClean !== isClean) moved.push(isClean ? 'tree was dirty at capture, is clean now' : 'tree was clean at capture, is dirty now');
  }
  // An unreadable value at capture is not a previous state to compare against. Without this, every
  // field STATE could not read became a phantom change the moment the next session could read it.
  const phantom = moved.filter((m) => m.includes('(unreadable)'));
  for (const p of phantom) moved.splice(moved.indexOf(p), 1);
  if (!moved.length) return '';
  return `The repo has moved since this was captured: ${moved.join('; ')}. Where the notes below disagree with that, the repo is right.`;
}

/**
 * What happened AFTER this handoff was sealed — the bridge across the gap.
 *
 * A handoff is a photograph. Everything below the fence describes the world as it was at capture,
 * and the moment anyone commits, that description is a little bit false with no way for the reader
 * to tell which part. Resuming this repo's own handoff, one commit had landed since capture; the
 * payload could not know it existed, and the only reason it did not cause damage is that someone
 * ran `git log` on a hunch.
 *
 * So delulu computes the delta itself and hands it over. This is the difference between a snapshot
 * and a continuation: the next session gets the notes AND the diff between the notes and now.
 *
 * Silent whenever it cannot be sure — an unknown SHA (a different clone, a rewritten history) buys
 * a listing of commits that may have nothing to do with this handoff, which is worse than nothing.
 */
function sinceCapture(repo: string, body: string): string {
  const m = body.match(/^- Branch `[^`]+` @ `([^`]+)` · tree /m);
  if (!m) return '';
  const was = m[1];
  if (!/^[0-9a-f]{7,40}$/.test(was)) return ''; // "(no commit)" and friends
  const git = (args: string[]): string | undefined => {
    try { return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { env: gitEnv(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return undefined; }
  };
  if (git(['cat-file', '-e', `${was}^{commit}`]) === undefined) return ''; // not in THIS repo
  // REACHABILITY FIRST, and asked directly. Deriving it from an empty `was..HEAD` is wrong: when
  // the histories are unrelated (an orphan branch, a rewritten history) that range lists EVERY
  // commit on HEAD, so the range is non-empty and the rewind goes unreported — dressed up as
  // "commits landed since", which is the opposite of what happened.
  if (git(['merge-base', '--is-ancestor', was, 'HEAD']) === undefined) {
    return `Captured at \`${was}\`, which is NOT reachable from HEAD, history was rewound or rewritten. Work described below may not exist in this checkout.`;
  }
  const ahead = git(['log', '--oneline', '--no-decorate', `${was}..HEAD`]);
  if (!ahead) return '';
  // THREE, not eight. The point of this line is "work happened that the notes cannot know about",
  // and that lands in one glance; the full list is one command away and does not belong in a
  // preamble the reader has to get past to reach the handoff itself.
  const lines = ahead.split('\n');
  const shown = lines.slice(0, 3).map((l) => `    ${l}`).join('\n');
  const stat = git(['diff', '--shortstat', `${was}..HEAD`]);
  return `${lines.length} commit${lines.length === 1 ? '' : 's'} landed after it was captured${stat ? ` (${stat})` : ''}, so nothing below knows about ${lines.length === 1 ? 'it' : 'them'}:\n${shown}`
    + (lines.length > 3 ? `\n    +${lines.length - 3} more, \`git log ${was}..HEAD\`` : '');
}

/**
 * Does NEXT still point at something that has not moved?
 *
 * NEXT is the one instruction the payload asks the reader to act on FIRST, and it is written as
 * `file.ts:843`. Line numbers are the most perishable thing in a handoff: resuming this repo's own
 * note, every anchor in it had shifted by about fifteen lines because the file had been edited in
 * between, and the reader only found out by opening each one. Worse than a wrong number is a
 * confident one.
 *
 * Rather than guess what SHOULD be at a line, this says the honest thing it can prove: this file
 * changed after the handoff was captured, so treat the instruction as approximate and re-locate it.
 * Only files the payload actually names in NEXT are considered, and only against the commits since
 * capture — so it stays quiet on a repo that has not moved.
 */
function nextAnchorsMoved(repo: string, body: string): string {
  const m = body.match(/^- Branch `[^`]+` @ `([^`]+)` · tree /m);
  if (!m || !/^[0-9a-f]{7,40}$/.test(m[1])) return '';
  const was = m[1];
  const start = body.indexOf(`## ${SECTION.next}`);
  if (start < 0) return '';
  const rest = body.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const next = end < 0 ? rest : rest.slice(0, end);
  // Only paths delulu itself would have written: inside backticks, with a directory and a suffix.
  //
  // The shape is tested in CODE, not in the character class, because an ASCII-only class does not
  // narrow this check — it silently switches it off. `src/café-日本語.ts` and `src/dir with
  // spaces/plain.ts` matched nothing, so a payload naming one of them was reported as "a file"
  // changed when two had, or as nothing at all: a quiet undercount in the one line that tells the
  // reader their line numbers have drifted.
  //
  // Widening is safe here in a way it would not be elsewhere. Nothing is printed on a match alone —
  // every candidate is intersected with what `git diff --name-only` independently reports below, so
  // a span that is not really a path simply never appears in the changed set. The failure the class
  // was guarding against costs nothing; the one it caused is silent.
  // A backslash counts as a separator here too: an agent writing NEXT on Windows types
  // `app\src\x.ts`, which held no '/' and so was not recognised as a path at all. Widening costs
  // nothing for the same reason the paragraph above gives — a candidate that is not really a path
  // simply never appears in the changed set below.
  const named = new Set<string>();
  for (const mm of next.matchAll(/`([^`\n]+)`/g)) {
    const raw = mm[1].replace(/:\d+$/, '');
    if (/[/\\]/.test(raw) && /\.[A-Za-z0-9]+$/.test(raw)) named.add(raw);
  }
  if (!named.size) return '';
  let changed: string[];
  try {
    // `-z` for the same reason the capture side uses it: `core.quotePath=false` stops the octal
    // escaping but git still C-quotes a path holding a double quote, a backslash or a tab, and a
    // quoted name never equals the plain one the payload wrote, so the drift warning went quiet on
    // exactly the paths most likely to be mistyped.
    const out = execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '-z', `${was}..HEAD`], { env: gitEnv(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    changed = out.split('\0').filter((c) => c !== '');
  } catch { return ''; }
  if (!changed.length) return '';
  // A payload may name `app/src/x.ts` while git reports the same path, or name it repo-relative
  // from a subdirectory; compare on suffix so both forms match without inventing a mapping.
  const hit = [...named].filter((n) => changed.some((c) => namesSameRepoFile(n, c)));
  if (!hit.length) return '';
  return `${hit.length === 1 ? 'A file' : `${hit.length} files`} the plan points at ${hit.length === 1 ? 'has' : 'have'} changed since this was captured (${hit.map((h) => `\`${h}\``).join(', ')}), so any line numbers in it have drifted — find the code again before you act on it.`;
}
/**
 * DELIVERY, the payload has to survive the pipe, not just the disk.
 *
 * Why this exists at all is documented at `SAFE_DELIVERY_BYTES` in payload.ts: everything below is
 * written by one `process.stdout.write`, `commands/resume.md` reads that stdout, and the harness
 * silently replaces a Bash output above ~30,000 bytes with a 2KB preview. Above the cliff the next
 * session gets the title line, half of STATE, and a promise from resume.md that it has "full
 * context" and must never re-ask what the handoff answers.
 *
 * Three shapes were on the table:
 *   a) print everything and hope, today's behaviour, and the bug;
 *   b) above a threshold print nothing but "Read the file", honest, but it throws away the whole
 *      handoff to defend against losing part of it, and pays a Read on payloads that would have
 *      arrived intact;
 *   c) spend the budget on the blocks that matter most and SAY, at the top, which ones were left
 *      out and where to get them.
 * (c), with (b) as the floor for when even the spine will not fit. What decides it: (c) never
 * loses anything the reader cannot name and recover, the dropped blocks are on disk, unabridged,
 * at a path printed in the first paragraph, and `Read` is not subject to this limit. What (a)
 * loses, it loses without telling anyone, which is the one thing this codebase does not do.
 *
 * Nothing here rewrites, summarises or re-orders a payload. A kept block is emitted byte for byte
 * in file order; the only operation available is leaving one out and naming it.
 */
interface Piece { name: string; text: string; }

/**
 * Cut the payload into blocks WITHOUT losing the mortar between them.
 *
 * The cuts are: every `## ` heading, the fence paragraph (`AGENT_ZONE`), and the closing
 * "Continue from NEXT" line. The last two matter, neither is a heading, so a heading-only split
 * leaves them hanging off the tail of the block above them, and dropping that block would take the
 * "everything below is NOT verified" warning with it. Keeping the unverified prose while dropping
 * the line that says it is unverified is a worse outcome than any byte count.
 *
 * A piece is named only when it starts with a heading; the lead (title), the fence and the closer
 * come back unnamed, which is what makes them undroppable below.
 */
function splitPayload(body: string): Piece[] {
  const cuts = new Set<number>([0]);
  for (const m of body.matchAll(/^## [^\n]*$/gm)) if (m.index !== undefined) cuts.add(m.index);
  const fence = body.indexOf(AGENT_ZONE);
  if (fence > 0) cuts.add(fence);
  const closer = body.match(new RegExp(`\\n---\\n${CLOSER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^]*$`));
  if (closer && closer.index !== undefined && closer.index > 0) cuts.add(closer.index);
  const at = [...cuts].sort((a, b) => a - b);
  return at.map((start, i) => {
    const text = body.slice(start, at[i + 1] ?? body.length);
    const nl = text.indexOf('\n');
    return { name: text.startsWith('## ') ? text.slice(3, nl === -1 ? undefined : nl) : '', text };
  });
}

/** `## THE AGENT'S READ, the last agent's conclusions, NOT proven` -> `THE AGENT'S READ`. */
function blockName(heading: string): string {
  return sectionOf(heading).replace(/\s*\(.*$/, '').trim();
}

/**
 * Fit the payload into `budget` bytes by leaving out whole blocks, least-critical first.
 *
 * Returns the kept text, byte-identical to its slices of the original, plus the names of what
 * was left out, or `null` when even the undroppable spine is too big. `null` is not a failure of
 * this function: it is the honest answer, and the caller turns it into one.
 *
 * A heading delulu did not write is not in `DELIVERY_DROP_ORDER`, so it is never dropped. That
 * costs bytes on a hand-edited payload and can push it to the `null` path, deliberately. Guessing
 * that unrecognised content is unimportant is how you delete the one section someone added because
 * it mattered. `SECTION.holds` is absent from that list for the opposite reason and by the same
 * mechanism: a standing rule a size guard can silently delete is not a standing rule.
 */
function fitForDelivery(body: string, budget: number): { text: string; dropped: string[] } | null {
  let size = deliveryBytes(body);
  if (size <= budget) return { text: body, dropped: [] };
  const pieces = splitPayload(body);
  const gone = new Set<number>();
  const dropped: string[] = [];
  // Whole passes in priority order, and the size test is BEFORE each pass rather than inside it:
  // dropping until the arithmetic works would keep `Full context` and drop `DECIDED` on a payload
  // whose block sizes happened to fall that way. Priority decides what goes; size only decides how
  // far down the list we get.
  for (const name of DELIVERY_DROP_ORDER) {
    if (size <= budget) break;
    // Every name this block has ever carried (see `ALSO_KNOWN_AS`). Spelling only today's name
    // would stop a sealed handoff's block being recognised as droppable — no error, and the pipe
    // cuts the payload instead of delulu choosing what to leave out.
    const heads = headingsFor(name);
    for (let i = 0; i < pieces.length; i++) {
      if (gone.has(i) || !heads.some((h) => pieces[i].text.startsWith(`## ${h}`))) continue;
      gone.add(i);
      dropped.push(blockName(pieces[i].name));
      size -= deliveryBytes(pieces[i].text);
    }
  }
  if (size > budget) return null;
  return { text: pieces.filter((_, i) => !gone.has(i)).map((p) => p.text).join(''), dropped };
}

/**
 * The notice, and where it goes: FIRST, straight under the loading line.
 *
 * The first 2KB is the only part of an over-cliff output guaranteed to arrive, so a warning placed
 * anywhere else is a warning truncated by the thing it warns about. It is also why this text is
 * short and why the SINCE YOU LEFT / provenance blocks stay below it — every byte ahead of the
 * notice is budget a truncated output spends before reaching it.
 *
 * It names the blocks and the path because "some content was omitted" is not recoverable
 * information. `Read` has no such limit, so the repair is one tool call on a file that is complete.
 *
 * It asks for the DROPPED BLOCKS, not for the file. Measured on this repo's two handoffs that trim:
 * one block is left out — 2,061 and 2,655 bytes — and ordering a full re-read of the 23,932-byte
 * file to recover it cost the next session about 24KB to get back 2KB, roughly 11k tokens against
 * "less displayed output is better, because output is the next session's context". Both payloads
 * would in fact have fitted under the real cliff; the budget below it is deliberate headroom, so
 * the trim is not the defect. The remedy being ten times the size of what it recovers is.
 */
function trimNotice(ts: string, dropped: string[], full: number): string {
  return `Heads up, this handoff was too big to send whole, so ${dropped.length} block(s) aren't below: ${dropped.join(', ')}.\n`
    + `  It's ${full.toLocaleString('en-US')} bytes, and anything over about ${BASH_OUTPUT_CLIFF.toLocaleString('en-US')} gets quietly replaced with a short preview, no error, nothing to notice. So delulu chose what to leave out and named it, rather than letting the cut land wherever it fell.\n`
    // The trailing newline is load-bearing. Without it the notice's last sentence ran straight into
    // the first sentence of the preamble — `…in that file in full.A few of the notes below don't
    // hold up` — and two sentences with no gap between them read as one. The half that gets
    // swallowed is the instruction to go and read the file, which is the entire point of the notice.
    + `  NOTHING WAS LOST, the whole handoff is on disk. Read \`.delulu-handoff/${ts}/payload.md\` now, before you answer. Read has no size limit; what is printed below is only the part that fitted through one command's output, and the ${dropped.length === 1 ? 'block' : 'blocks'} named above ${dropped.length === 1 ? 'is' : 'are'} in that file in full.\n`;
}

/** The floor: nothing optional was left to drop, so nothing is claimed at all. */
function undeliverableNotice(ts: string, full: number): string {
  return `Heads up, the handoff didn't fit in this output at all. Nothing below is it.\n`
    + `  It's ${full.toLocaleString('en-US')} bytes, and even after dropping every optional block it still doesn't fit under the ~${BASH_OUTPUT_CLIFF.toLocaleString('en-US')} byte limit. Printing part of it would look exactly like all of it, which is worse than printing none.\n`
    + `  Read \`.delulu-handoff/${ts}/payload.md\` in full before you answer, Read has no such limit. That file is the handoff; this output isn't.\n`;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stdout.write(`delulu resume, ${parsed.error}. Nothing was loaded.\n`);
    process.exitCode = 1;
    return;
  }
  const args = parsed;
  let repo: string;
  try { repo = repoKey(args.repo ?? process.cwd()); }
  catch { process.stdout.write('delulu resume, not a readable path.\n'); return; }

  const base = join(repo, '.delulu-handoff');
  const all = listHandoffs(base);
  if (!all.length) {
    clearStaleNudge(base); // stale marker with no folders -> stop nagging
    process.stdout.write('delulu resume, no handoffs yet for this project. (run `delulu handoff` at the end of a session to create one.)\n');
    return;
  }

  // --list: browse the persistent library. Never touches the nudge.
  if (args.list) {
    // The stamp is no longer printed here. It is still the folder on disk and still the address
    // every stored citation resolves through — but it answered none of the questions asked of this
    // list ("when was this", "what was it about"), and it led every line. What leads now is the
    // name; the date and age follow it, and the age is computed HERE rather than stored, because a
    // relative quantity written into a file is false the moment the next handoff lands.
    const now = new Date();
    const rows = all.map((h, i) => {
      const when = stampWhen(h.ts, now);
      const stale = when ? `${when.day} · ${when.age}` : h.ts;
      return {
        lead: i === 0 ? '→' : ' ',
        name: handoffLabel(base, h.ts, now),
        // A draft is dated but never aged: "3 days ago" invites resuming it, and there is nothing
        // in it to resume — delulu's own unfilled template is still sitting where THREAD goes.
        meta: isIncomplete(h.payload) ? `${when ? when.day : h.ts} · draft, never finished` : stale,
      };
    });
    const w = Math.max(...rows.map((r) => r.name.length));
    process.stdout.write(`delulu handoffs (${all.length}, newest first), \`delulu resume <name>\` to load any:\n`);
    for (const r of rows) process.stdout.write(`  ${r.lead} ${r.name.padEnd(w)}   ${r.meta}\n`);
    return;
  }

  // Pick a specific handoff by prefix. Multiple same-day matches -> newest, with a note
  // so you can grab an earlier one by a longer prefix (or from --list).
  // The newest USABLE handoff, not merely the newest folder. An abandoned draft is newest by
  // definition from the moment it is abandoned, so `resume` with no argument — the ordinary way
  // this tool is used — pointed at a document whose agent-written half is still delulu's own
  // unfilled template. That template is several kilobytes of second-person instructions, and it
  // arrived in the fresh session as if it were last session's notes.
  //
  // Falling back to a draft when a draft is all there is stays right: it still holds the user's
  // verbatim words and the engine-verified state, which is most of the value. What was wrong was
  // preferring one while a finished handoff sat underneath it.
  const newestDone = all.find((h) => !isIncomplete(h.payload));
  let chosen = newestDone ?? all[0];
  let skippedDrafts = newestDone ? all.indexOf(newestDone) : 0;
  let ambiguous = '';
  if (args.pick) {
    // Stamp prefix is tried FIRST and a hit ends it: every stored ref, every older habit and every
    // path in a payload names a handoff by stamp, and a fuzzy name must never shadow an exact
    // address the user typed. Only when nothing matches the stamp does the human name get a turn.
    const q = args.pick.toLowerCase();
    const byStamp = all.filter((h) => h.ts.startsWith(args.pick!));
    // Matched against the LABEL, which is what `--list` actually printed — not against the stored
    // name. A handoff nobody named lists as "Aug 27 handoff", and matching only `name.txt` meant
    // the list showed a selector the tool then rejected: the one string a reader is invited to
    // copy was the one string guaranteed to fail. The only thing that worked was the stamp, which
    // is precisely what this tool goes out of its way never to print.
    const matches = byStamp.length
      ? byStamp
      : all.filter((h) => handoffLabel(base, h.ts, new Date()).toLowerCase().includes(q));
    if (!matches.length) {
      // Exit 1: you named something and it was not there, so nothing was loaded. Exit 0 here told
      // any script, hook or agent branching on the code that a named handoff had loaded — the same
      // false green the dispatcher's own comment forbids two files away. The bare `resume` with no
      // handoffs yet stays 0, because that is a true and expected state rather than a failed ask.
      process.stdout.write(`delulu resume, no handoff matching "${args.pick}". Try \`delulu resume --list\`.\n`);
      process.exitCode = 1;
      return;
    }
    chosen = matches[0];
    skippedDrafts = 0;   // you named it; a draft you asked for is the one you get
    if (matches.length > 1) ambiguous = `(${matches.length} handoffs match "${args.pick}", loaded the newest, from ${stampWhen(chosen.ts, new Date())?.day ?? chosen.ts}. Be more specific, or use \`delulu resume --list\` to see them all.)\n`;
  }

  // Read FIRST, clear after. Clearing ahead of the read meant an unreadable payload (a permission
  // error, a half-written file) printed "could not load the handoff" and still deleted the
  // "you have an unresumed handoff" nudge — permanently, having loaded nothing.
  // NON-DESTRUCTIVE: the folder is never removed — resume again anytime, any day.
  const body = readFileSync(chosen.payload, 'utf8');
  if (chosen.ts === all[0].ts) clearStaleNudge(base);
  // Provenance check at LOAD time — the moment before the agent starts treating the notes as
  // fact. `citations.json` was written beside the payload at capture, so this works in a fresh
  // session with the original transcript long gone. An absent or empty record checks nothing and
  // SAYS so — it is never an accusation, and it is never silence either. Never blocks; heads-up only.
  let citeHard: string[] = [];
  let citeSoft: string[] = [];
  let citeWeak: string[] = [];
  let citeCarried: string[] = [];
  let citeUnrecorded: string[] = [];
  try {
    // Parsed by the ONE definition, in citations.ts, which tolerates every older record shape:
    // before utterances existed, before answers were stored separately (one string, not a list),
    // before clipped lengths were recorded, before `recommended` did. This block used to hold its
    // own copy of that parsing; a second copy of "how to read the record" beside a second copy of
    // "how to find it" is two chances for the load-time check and the seal-time check to disagree
    // about the same file.
    let rec: CitationRecord | null = null;
    try { rec = parseCitationRecord(readFileSync(join(base, chosen.ts, 'citations.json'), 'utf8')); }
    catch { rec = null; }
    // A MISSING record no longer means silence. `if (rec)` skipped the check entirely, so a handoff
    // with no `citations.json` beside it — this repo's own `2026-06-18T19-53-37` — loaded a cited,
    // fabricated ruling with no notice at all. An empty record checks nothing and SAYS so; skipping
    // the call says nothing, and nothing reads as "these hold up".
    const held: CitationRecord = rec ?? { userLines: [], utterances: {}, truncated: {}, recommended: {} };
    ({ hard: citeHard, soft: citeSoft, weak: citeWeak, carried: citeCarried, unrecorded: citeUnrecorded } = citationItems(
      // The lookup is the whole point of loading in a fresh session: a DECIDED line carried from an
      // OLDER handoff cites that handoff's stamp, and the record it needs is sitting in the same
      // library this resume is reading from. Without it every forwarded constraint scored as a
      // fabrication, which is why they stopped being forwarded at all.
      checkCitations(body, held.userLines, held.utterances, held.truncated, { recommended: held.recommended, carried: carriedLookup(base), absent: held.absent }),
    ));
  } catch { /* no record, or unreadable — stay silent rather than accuse */ }

  // The notice quotes the same refs the payload does, so it gets the same treatment — otherwise the
  // one block whose whole job is telling you which citations to distrust would be the last place
  // still naming them by a string you cannot read.
  const asNames = (xs: string[]) => xs.map((x) => nameCarriedRefs(x, base, new Date()));
  [citeHard, citeSoft, citeWeak, citeCarried] = [citeHard, citeSoft, citeWeak, citeCarried].map(asNames);

  // Every carried citation now shows the NAME of the handoff it points at instead of its stamp.
  // Deliberately HERE: after the citation check has read the stored text (so what was verified and
  // what is displayed are the same claim), and before the delivery budget is measured (so the size
  // accounted for is the size actually printed).
  // ONLY the title. Carried citations inside the payload keep their stamp, deliberately.
  //
  // Renaming them read better and broke the thing they exist for: `commands/resume.md` tells the
  // next agent to carry a constraint forward WITH ITS ORIGINAL REF, and an agent copying
  // `continuity is the product · L92` writes a ref that `refScan` cannot parse — so the check
  // reports an honest carry-forward as uncited. A false accusation on a true statement is the one
  // failure this codebase refuses to ship. The name also could not survive a same-day collision:
  // two handoffs from Aug 17 both render "Aug 17 handoff".
  //
  // The payload is written for the next AI session; the list, the loading line and the warnings are
  // written for a person. Names belong on the second set, addresses on the first.
  const shown = nameTitle(body, base, new Date());
  // Say exactly what is wrong, and name the handoff to fall back to. delulu SHOWS and never
  // blocks — but staying silent about a payload that is empty, truncated or half-written is not
  // showing. A 0-byte payload used to load with no warning at all and silently shadow the good
  // handoff sitting beside it.
  const problem = payloadProblem(body);
  // A handoff whose interview was ABANDONED still carries delulu's own `delulu:fill` placeholder,
  // and older templates put a literal `L412` in their worked example. The grader reads that example
  // as a decision citing a line the user never spoke — so delulu accused ITSELF of fabricating,
  // which is the one thing it is not allowed to do.
  //
  // The grader is deliberately NOT relaxed to fix this. It skips delulu's placeholder only while
  // that placeholder is PRISTINE, and the ten attack shapes in citations.test.ts are what that
  // rule buys: a ruling written INSIDE our own boilerplate must still be reported, because a
  // dropped decision is a fabrication passing unreported. Widening the skip to any closed
  // `delulu:fill` span would trade that whole defence for one stale file.
  //
  // So the fix is here, where the two facts meet: when the payload ALREADY reports unfilled
  // sections, the findings below may be delulu's own instruction text rather than anything an
  // agent wrote, and saying so is the difference between showing and accusing.
  const unfilled = problem.includes('never filled in');
  // THE SAME CHECK THE SEAL RAN, RUN AGAIN HERE — and this is the half that matters, because the
  // session that can act on the answer is this one, not the one that has already ended. A handoff
  // sealed by an agent that ignored the seal-time heads-up still arrives carrying the news that it
  // did. Silent whenever there is no earlier handoff, or nothing was lost, which is most loads.
  const carryLoss = droppedCarried(base, chosen.ts, body);
  // By NAME, never by stamp — the same rule the title, the list and the citation refs already obey.
  const loss = carryItems(carryLoss, carryLoss ? handoffLabel(base, carryLoss.stamp, new Date()) : '');
  const driftNote = stateDrift(repo, body);
  const sinceNote = sinceCapture(repo, body);
  const anchorNote = nextAnchorsMoved(repo, body);
  const fallback = all.find((h) => h.ts !== chosen.ts && !isIncomplete(h.payload));
  const problemNote = problem
    ? `This handoff is INCOMPLETE, ${problem}. Treat anything missing as unknown, not as settled.` +
      (fallback ? ` Newest complete: ${fallback.ts} (\`delulu resume ${fallback.ts}\`).` : '')
    : '';
  // Named as the payload names them: pointing a fresh session at a heading that is not in the file
  // in front of it is how a reader learns to skim the preamble.
  const ruling = rulingHeadings(body);
  const rulingNames = rulingBlockNames(body);
  // The rules block frames everything read after it, so it is announced before the reading order
  // rather than inside it — and only when the payload actually has one with something in it.
  const rulesLine = ruling.includes(SECTION.holds)
    ? ` Then "${SECTION.holds}", before the rest of the notes: standing rules the user locked and has not revoked, which frame everything below them, nothing there expires on its own, and only they retire one.`
    : '';
  // Same rule as `rulesLine` above, for the same reason: promise a file only when it holds
  // something. `context.md` exists on every handoff, and on a session with no subagents it holds a
  // single line saying there were none. Sending the next agent to read that costs it context and
  // tells it there is depth here that there is not. The payload names the file only when the
  // capture found findings to put in it, so the payload is the thing to ask.
  const deepLine = body.includes(`.delulu-handoff/${chosen.ts}/context.md`)
    ? ` If you need more depth than this, each subagent's full finding is in .delulu-handoff/${chosen.ts}/context.md.`
    : '';
  const tok = Math.max(0.1, Math.round(body.length / 400) / 10); // ~chars/4, in thousands
  const loadedAt = new Date();
  const loadedWhen = stampWhen(chosen.ts, loadedAt);
  const loadedMeta = [loadedWhen?.day, chosen.ts === all[0].ts ? 'latest' : ''].filter(Boolean).join(', ');
  const head = `delulu resume, loading "${handoffLabel(base, chosen.ts, loadedAt)}"${loadedMeta ? ` (${loadedMeta})` : ''} · payload ≈ ${tok}k tokens.\n`;
  const preamble =
    (skippedDrafts
      ? `(skipped ${skippedDrafts} newer unfinished draft${skippedDrafts > 1 ? 's' : ''} and loaded the newest finished handoff. \`delulu resume --list\` shows them; name one to load it anyway.)\n`
      : '') +
    ambiguous +
    // ONE block, not five loose sentences. Each of these used to print as its own `delulu — ...`
    // line; three were added in a single day and the preamble grew to 2,615 characters of prose the
    // reader has to wade through BEFORE reaching the handoff. They answer one question between
    // them — what is different now from what the notes below describe — so they are one block, and
    // the whole block disappears when the answer is "nothing".
    sinceYouLeft([problemNote, driftNote, sinceNote, anchorNote]) +
    beforeYouTrust({ hard: citeHard, soft: citeSoft, weak: citeWeak, carried: citeCarried, unrecorded: citeUnrecorded, lost: asNames(loss.lost), lostNote: loss.untouchedNote, unfilled }) +
    `Start with "${SECTION.said}", those are their own messages, word for word and in order, and reading them is what makes this a continuation instead of a briefing.${rulesLine} Then "${SECTION.thread}", "${SECTION.state}" and "${SECTION.next}". Open by carrying the conversation on in your own voice rather than reciting these blocks back at them, and put your first question to them with AskUserQuestion, your recommendation first, never end on a bare question or a flat stop. On what to trust: delulu read "${SECTION.state}" and "${SECTION.said}" itself. Every line under ${namedBlocks(rulingNames)} is only as good as the citation on it, and "${SECTION.read}" was never checked at all.${deepLine}\n\n`;

  // THE DELIVERY BUDGET. The preamble above is not free — it is the same stdout and it spends the
  // same bytes, and on a payload with many flagged citations it is the part that grew. So the body
  // is fitted against what is LEFT, measured, not against the payload size alone.
  //
  // The notice has to be paid for before it can be written, and its length depends on the block
  // names it will carry — so a reserve is taken up front and the real total is re-checked after.
  // A notice that overran its reserve would push the output back over the cliff and truncate the
  // very sentence explaining the truncation; if that ever happens the floor catches it.
  const full = deliveryBytes(shown);
  const fixed = deliveryBytes(head) + deliveryBytes(preamble);
  const NOTICE_RESERVE = 900;
  let notice = '';
  let delivered = shown;
  if (fixed + full > SAFE_DELIVERY_BYTES) {
    const fit = fitForDelivery(shown, SAFE_DELIVERY_BYTES - fixed - NOTICE_RESERVE);
    if (fit && fit.dropped.length) {
      notice = trimNotice(chosen.ts, fit.dropped, full);
      delivered = fit.text;
    }
    if (!notice || fixed + deliveryBytes(notice) + deliveryBytes(delivered) > SAFE_DELIVERY_BYTES) {
      // Nothing droppable was enough, or paying for the notice put us back over. Either way the
      // payload does not travel, and half a payload under a heading that says "full context" is
      // the failure this whole file is defending against. Say so, send them to the file, and exit
      // non-zero: this run loaded nothing, and `resume` already reserves a non-zero exit for
      // exactly that (an unreadable payload, an unknown flag). Exit 0 here would be a false green.
      notice = undeliverableNotice(chosen.ts, full);
      delivered = '';
      process.exitCode = 1;
    }
  }
  // Order is load-bearing: loading line, then the notice, then everything else. Only the first 2KB
  // is guaranteed to arrive when an output is cut, and a warning below the preamble is a warning
  // the reader never sees.
  process.stdout.write(head + notice + preamble + delivered);
}

// Only when this file IS the program. Importing `resume` also unlinks the PENDING marker, so an
// import does not merely waste work — it mutates. `isProgram` degrades OPEN by design.
try { if (isProgram(import.meta.url)) main(); }
catch (e) {
  // Exit non-zero. Printing the failure and exiting 0 made "nothing was loaded" indistinguishable
  // from a successful resume to anything reading the code rather than the prose.
  process.stdout.write(`delulu resume, could not load the handoff: ${e instanceof Error ? e.message : 'unknown'}\n`);
  process.exitCode = 1;
}
