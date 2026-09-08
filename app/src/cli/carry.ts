// Carrying a constraint ACROSS a session boundary, and noticing when one falls off.
//
// Its own module because both CLIs need every line of it and neither may own it. `handoff` emits
// the candidates into the draft and checks the sealed file against them; `resume` runs the same
// check again at load, so the session that inherits a lossy handoff is told what its predecessor
// let go. Two copies of "how a constraint travels" is how two copies of one predicate in this
// codebase already drifted apart and deleted a handoff between them.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decidedEntries } from './citations';
import { CARRY_REASON_MARKER, RULING_SECTIONS, SECTION, carryReason, classifyRuling, headingRe, isIncompletePayload, sectionBodies } from './payload';
import type { Lifetime } from './payload';

/**
 * A ceiling on the SPENT and UNSORTED tail. It cannot reach a standing rule.
 *
 * The carried block is a `delulu:fill` comment the agent deletes once it has promoted from it, so
 * it costs delivery bytes only in a payload that was ABANDONED mid-capture — a far weaker
 * constraint than the 12 this started at, which on the real library cut 4 of one handoff's 16
 * rulings. Finite so a pathological library cannot produce an unbounded draft.
 *
 * This was previously applied to the whole candidate list and documented as "high enough that a
 * real session never reaches it". That stopped being true: the rules block reached 29 lines,
 * having grown by four in one session, and the next capture would have offered 38 candidates
 * against a ceiling of 30. Rules accumulate by design and only the user retires one, so the number
 * moves in one direction and any fixed ceiling eventually binds on exactly the lines that must
 * never be cut. The caller now shows every `rules` line and spends the ceiling on the rest.
 *
 * It bounds what is SHOWN and nothing else. The drop check below reads the uncapped set, or a
 * constraint pushed past the ceiling would be reported as dropped by an agent who was never shown
 * it — delulu accusing someone of losing something delulu withheld.
 */
export const CARRIED_CAP = 30;

/** The line that heads the engine's carried block. Named here so the check can recognise its own. */
export const CARRIED_MARKER = 'CARRIED FORWARD';

/** Re-exported so prompts, checks and tests all name the marker from one place. */
export { CARRY_REASON_MARKER };

/**
 * The carried block's OPENER, not merely its name — and the difference is a real defect.
 *
 * `untouched` was a bare search for CARRIED_MARKER anywhere in the payload. But a payload quotes
 * the user verbatim and carries the agent's own prose, so any session that DISCUSSED the carry
 * mechanism — delulu's own development sessions, mostly — set the flag while having worked the
 * block through perfectly.
 *
 * That is not a cosmetic mislabel. `carryItems` returns the untouched note INSTEAD of the loss
 * list, so a genuinely dropped standing rule went unreported and was replaced by a statement that
 * nothing had been promoted out of the block — false, and suppressing exactly the alarm this
 * module exists to raise. Proven with two payloads identical but for one sentence of prose: the
 * control named the lost rule, the other announced that nothing was ever promoted.
 *
 * Matching the comment opener means only a block delulu itself wrote, and nobody deleted, can set
 * it. If the emission in `handoff.ts` is ever reworded past this, the flag goes quiet rather than
 * loud — losses get NAMED instead of being hidden behind a false all-clear, which is the safe
 * direction to fail in. `handoff.test.ts` pins the emitted wording separately.
 */
// Both separators, for the same reason the other markers accept both: a PENDING draft is written
// to disk and worked through later, so one sealed by the version that still wrote em-dashes can be
// resumed by this one. Spelling only today's separator would report that draft's carried block as
// never-written, which flips `untouched` to false and names every carried rule as lost.
const CARRIED_BLOCK_OPEN = new RegExp(`<!-- delulu:fill[—,] ${CARRIED_MARKER}`);

/** Exactly the folder names `handoff` creates: a stamp, optionally `-2` on a same-second collision. */
const STAMP_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

/** A ref that already names its session — i.e. a line that has survived at least one hop. */
const SESSION_QUALIFIED = /`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?:L\d+)`/g;

/**
 * One ruling offered to the next session.
 *
 * `proven` and `life` answer different questions and must not be collapsed. `life` is delulu's
 * GUESS at where the line belongs, read off its wording. `proven` is a FACT about it: the user
 * filed it under the rules block, or it already carried a session-qualified ref, so it has visibly
 * crossed a session boundary before. Only `proven` may raise its voice when a line goes missing —
 * a guess is not grounds for telling someone they lost something.
 */
export interface CarriedLine {
  text: string;
  life: Lifetime;
  proven: boolean;
  /** It states, in the open, why no check could hold it — the only reason a line keeps its place. */
  unenforceable: boolean;
}

export interface Carried { stamp: string; lines: CarriedLine[] }

/**
 * The decisions the user locked in the previous handoff, re-addressed to the handoff that holds
 * their words.
 *
 * Carrying a constraint forward was an INSTRUCTION and nothing else. `commands/handoff.md` has
 * spelled out the `<stamp>:L<n>` form since `dd060b1`, and `carriedLookup` could already validate
 * one — but nothing ever put the prior decisions in front of the agent, so the agent wrote its
 * DECIDED block from this transcript alone and every earlier constraint fell off the end. Measured
 * on the six handoffs stored in this repo when this was written: ZERO carried refs, in any of them,
 * in any era.
 *
 * The cost of that gap was measured too. "Continuity is the product" was locked on 2026-08-17
 * (`2026-08-17T20-01-36`, `L92`) alongside "the worst possible failure is being made to say
 * something twice". Neither appeared in ANY later handoff — not the phrase, not a paraphrase; the
 * successor payloads scored 0 for "continuity", "re-explain", "seamless" and "twice" alike. The
 * user then restated that same requirement in five separate sessions across thirteen days and
 * wrote "i have told you a thousand times". delulu dropped the one decision that defined it, by
 * the exact mechanism that decision named.
 *
 * So the engine emits them rather than asking the agent to remember. A line that ALREADY carries a
 * session-qualified ref keeps its original stamp untouched — that is what lets a constraint locked
 * five sessions back still arrive bearing the address of the session that actually holds its words,
 * instead of being re-pointed at a line in this transcript that says something else entirely.
 *
 * Emitting them was necessary and not sufficient, and the gap between those two words is this
 * module's other half. What the engine emits is a comment the AGENT then deletes and re-authors, so
 * carrying was engine-SURFACED, not engine-enforced: nothing checked that a candidate reached the
 * sealed file. `droppedCarried` below is that check.
 *
 * ONE HOP, deliberately. This reads the newest complete handoff older than `before` and stops. A
 * constraint therefore survives two boundaries only if the session in between re-promotes it — and
 * the answer to that is not to reach further back, which would resurrect rules the user really did
 * retire (not copying one forward is how a rule is revoked). The answer is that a drop is now
 * ANNOUNCED, at the seal that caused it and again at the load that inherits it, while the line's
 * own text and ref are still on screen and can be put back.
 */
export function carriedCandidates(base: string, before: string): Carried | null {
  let names: string[];
  try { names = readdirSync(base); } catch { return null; }
  // Strictly OLDER than `before`, not merely "not it". `handoff` always asks about the folder it
  // has just created, so the two were the same thing there — but `resume` asks about whichever
  // handoff the user loaded, and "not it" would hand an old handoff its own SUCCESSOR's rulings and
  // then report every one of them as dropped.
  const prior = names.filter((n) => STAMP_DIR.test(n) && n < before).sort().reverse();
  for (const stamp of prior) {
    let payload: string;
    try { payload = readFileSync(join(base, stamp, 'payload.md'), 'utf8'); } catch { continue; }
    // A draft whose interview never happened carries delulu's own placeholder where the rulings
    // should be. Carrying from it would launder template prose into the next session as the user's
    // ruling — the single worst thing this module can emit — so walk past it to the last real one.
    if (isIncompletePayload(payload)) continue;
    const raw = decidedEntries(payload).filter((e) => e.text.trim());
    // PRE-SORTED HERE, and sorted BEFORE the refs are re-addressed.
    //
    // The order matters more than it looks. Re-addressing stamps a session-qualified ref onto every
    // bare line, so "has this survived a session boundary" — the strongest signal `classifyRuling`
    // has, and the whole basis of `proven` — would be true of ALL of them a moment later, answered
    // by a change this function had just made rather than by anything the user did.
    //
    // `e.section` is passed through so a line that was already in the PREVIOUS handoff's rules block
    // stays there without having to re-earn it: a rule leaves only when the user revokes it, and
    // making it re-qualify every session is silent decay wearing a different hat.
    const graded = raw.map((e) => ({
      text: e.text,
      life: classifyRuling(e.text, e.section),
      unenforceable: carryReason(e.text) !== undefined,
      proven: headingRe(SECTION.holds).test(`## ${e.section}`) || new RegExp(SESSION_QUALIFIED.source).test(e.text),
    }));
    // A constraint that has ALREADY survived a hop has proven it is durable; one first locked in
    // the session being carried from is as likely to be tactical and spent ("commit the stage-2
    // tree before any cleanup work"). So the durable end sorts first and is the last thing the
    // display ceiling can reach — and an unsorted line outranks one that names a single file,
    // because "no signal" is not the same as "signal that it is spent".
    const order: Lifetime[] = ['rules', 'unsorted', 'session'];
    // Two keys, because `life` and `proven` answer different questions and the display ceiling must
    // respect both. `life` is what delulu CLAIMS about a line and picks the group it is offered in.
    // `proven` is what is FACTUALLY true of it — that it has already survived a session boundary —
    // and decides how hard it is protected from the ceiling inside that group.
    //
    // Ordering on `life` alone was enough only while a hop-survivor was always classified `rules`.
    // It no longer is: a line the user filed under DECIDED is not promoted by its stamp any more,
    // because the stamp records that it was carried and not that it endures. That is the right
    // claim to stop making, and on its own it would have dropped a durable survivor behind thirty
    // tactical lines and off the end of the ceiling — trading a wrong label for a real loss.
    const lines = order.flatMap((life) =>
      graded.filter((e) => e.life === life).sort((a, b) => Number(b.proven) - Number(a.proven)))
      .map((e) => ({ ...e, text: e.text.replace(/`L(\d+)`/g, (_m, n: string) => `\`${stamp}:L${n}\``) }));
    if (lines.length) return { stamp, lines };
  }
  return null;
}

/** Every session-qualified ref in a piece of text — the durable identity of a carried ruling. */
function refsIn(text: string): string[] {
  return [...text.matchAll(SESSION_QUALIFIED)].map((m) => m[1]);
}

export interface CarryLoss {
  /** The handoff the candidates came from. */
  stamp: string;
  /**
   * Lines that SAID no check could hold them, and are not in this handoff. The alarm.
   *
   * Narrowed deliberately. It used to fire for anything that had crossed a session boundary, which
   * was right while carrying was the default. It no longer is: dropping a line whose constraint
   * belongs in a test is now the CORRECT outcome, and on the session that emptied a 29-line block
   * this fired 29 times, every one on a drop the user had just chosen. An alarm that is always
   * wrong is one nobody reads, and then the one that matters goes past unseen.
   */
  lost: CarriedLine[];
  /** How many carried lines were dropped routinely — from EITHER block. A count, never a list. */
  routine: number;
  /** The agent never worked through the carried block at all — every count below is meaningless. */
  untouched: boolean;
  /**
   * Lines this handoff KEEPS in the rules block without saying why a check could not hold them.
   *
   * The other half of the same rule. Naming what fell off is worthless if anything may be added
   * back unexamined — that is how the block reached 29 lines while every individual session looked
   * reasonable. A line that cannot say why it is not a test has not earned a place in every future
   * session's context.
   */
  unjustified: string[];
}

/**
 * WHAT THE HANDOFF LET GO — the difference between surfacing a constraint and enforcing one.
 *
 * The engine writes the previous session's rulings into the draft as a comment, and the agent then
 * deletes that comment and re-authors the blocks itself. Nothing checked that a candidate reached
 * the sealed file, so "delulu offered it" and "the handoff kept it" were never the same statement.
 * This makes them one: a candidate that does not appear is NAMED, at the seal that dropped it and
 * again at the load that inherits it.
 *
 * MATCHED BY REF, not by text. The agent is told to copy a line verbatim, but the sentence in front
 * of the quote is its own prose and it rewrites it; the `<stamp>:L<n>` ref is the one token that
 * cannot be paraphrased and still mean the same thing, and it is the thing the check downstream
 * resolves. A candidate counts as kept when ANY of its refs appears anywhere in either ruling block
 * — including the wrong one, because a rule filed under the block that dies is a sorting problem
 * (already reported, separately) and not a loss.
 *
 * The tie is broken toward SILENCE everywhere it can be: a ref reused for a different sentence
 * reads as kept, a candidate the display ceiling hid is still read from the uncapped set, and a
 * payload whose carried comment was never worked through reports `untouched` rather than one
 * finding per candidate. Being wrong loudly here would be an engine telling someone they lost
 * something they are looking at.
 *
 * TWO CLASSES, never sharing a sentence. Dropping a spent task directive is CORRECT and happens
 * every session; it is a count. Dropping a line that had already crossed a boundary — one the user
 * filed under the rules block, or one already wearing an earlier session's address — is the failure
 * this module exists for, and it is named, quoted and addressed.
 */
export function droppedCarried(base: string, before: string, payload: string): CarryLoss | null {
  const carried = carriedCandidates(base, before);
  if (!carried) return null;
  // Only the ruling blocks count as "kept". The carried candidates are emitted into a comment that
  // sits ABOVE the first ruling heading, so a draft nobody worked through cannot pass its own check
  // by still containing the comment delulu wrote.
  const kept = new Set(sectionBodies(payload, RULING_SECTIONS).flatMap((b) => refsIn(b.body)));
  const missing = carried.lines.filter((l) => !refsIn(l.text).some((r) => kept.has(r)));
  // Only the RULES block is asked to justify itself. A line under "What you decided this session"
  // is spent when the session is and never reaches another context, so demanding a reason there
  // would be asking someone to defend a note they are about to throw away.
  const held = sectionBodies(payload, [SECTION.holds]).flatMap((b) => b.body.split('\n'));
  return {
    stamp: carried.stamp,
    lost: missing.filter((l) => l.unenforceable),
    routine: missing.filter((l) => !l.unenforceable).length,
    untouched: CARRIED_BLOCK_OPEN.test(payload),
    unjustified: held.filter((l) => /^\s*[-*]\s+\S/.test(l) && carryReason(l) === undefined).map((l) => l.trim()),
  };
}

/**
 * The findings, without presentation — `handoff` prints them as standalone sentences at seal time,
 * `resume` folds them into its provenance block at load. The ITEM TEXT is written once.
 *
 * Three fields rather than one blob because the two CLIs spend different budgets. `handoff` prints
 * to a terminal a person is watching; `resume` prints into the next session's context window, where
 * every byte is charged against the payload itself. So `resume` takes `lost` and `untouchedNote`
 * and leaves `routineNote` behind — measured, not assumed: that one 277-byte sentence pushed this
 * repo's largest stored handoff past the delivery budget and cost it a 2,213-byte block of real
 * content. A count of the drops that were RIGHT is not worth a section of the ones it kept.
 *
 * Everything empty = nothing to say, which is most loads.
 */
/** @param label how to NAME the source handoff — its stamp must never reach a person (`L190`). */
export function carryItems(loss: CarryLoss | null, label: string): { lost: string[]; routineNote: string; untouchedNote: string; unjustified: string[] } {
  const none = { lost: [], routineNote: '', untouchedNote: '', unjustified: [] as string[] };
  if (!loss) return none;
  if (loss.untouched)
    return { ...none, untouchedNote: `the carried block from "${label}" is still sitting in this handoff unworked, nothing was promoted out of it, so treat every constraint that session locked as still open.` };
  const unjustified = loss.unjustified.map((l) => `${l.slice(0, 150)}, kept as a standing rule without saying why no check could hold it. Build it in, or add \`, ${CARRY_REASON_MARKER} <why>\`.`);
  const lost = loss.lost.map((l) => `${l.text.slice(0, 150)}, carried out of "${label}", not in this handoff`);
  // ONE sentence for the routine class, and a COUNT rather than a list. Dropping a spent task
  // directive is the right call and the commonest thing that happens at a session boundary; naming
  // each one would bury the two that matter under fifteen that do not, and would read as an
  // accusation of doing the job correctly.
  // "lines", not "session decisions": this class collects every routine drop, and a line that came
  // out of the previous handoff's RULES block lands here too when it was retired the correct way.
  // Calling that one of the last session's own decisions is a small false statement about which
  // block it came from, in the sentence whose whole job is to say the drop was routine.
  const note = loss.routine
    ? `${loss.routine} line(s) carried out of "${label}" were not carried on, that is usually right, since a directive about one task is spent when the task is, and a rule that became a check no longer needs restating, so this is a count rather than a list. They are all still readable in that handoff if one turns out to matter.`
    : '';
  return { lost, routineNote: note, untouchedNote: '', unjustified };
}
