// Decision provenance — the check that makes "the user decided this" falsifiable.
//
// The audit found a payload asserting `NO FABLE SUBAGENTS … permanent for this project` under a
// heading that read "settled, do NOT re-litigate". The user never said it. Nothing in the artifact
// distinguished a ruling he made from a conclusion the agent reached — they rendered identically,
// under the same authority.
//
// The fix is not a stronger instruction. It is a citation the engine can re-check: a DECIDED line
// must point at the transcript line where the user actually spoke. delulu writes the set of real
// user-utterance lines at capture time (`citations.json`), so both `--restate` and `resume` can
// verify every citation deterministically, with zero model calls, long after the session is gone.
//
// THE ADDRESS WAS NOT ENOUGH. Checking only `L<n>` asks "is this integer in a list printed a few
// lines above the agent's cursor?" — a question any agent can satisfy by reading the answer off the
// payload it is writing. Two probes confirmed the gap: a field test injected `- Delete the whole east district, user approved. L124`
// into a real payload and resume PASSED it (L124 is where the user pressed Escape); and a cold
// session found a live mis-cited ruling in a shipped handoff — the decision was real, the address
// was not. So a line may also carry the user's OWN WORDS, and those are checked against what the
// transcript records at that line:
//
//     - Free models only, never a paid API. L412: "i dont want a paid api"
//
// What this proves, exactly — and the payload must not claim more: the quoted words really were
// spoken at that line. It cannot prove the gloss in front of them is a fair reading of them. It
// raises fabrication from "append any integer" to "find real words that support the claim", and it
// puts those words in front of the human, which is the half that actually catches things.
//
// Per THE MIRROR: a bad citation is SHOWN, never blocked. The reader judges.
//
// ── PROVENANCE LAUNDERING: the agent quoting itself ──────────────────────────────────────────
// A citation proves the words were SPOKEN at that line. It never proved WHOSE words they were, and
// the gap is not theoretical — it is the dominant shape in this repo's own stored handoffs. Counted
// over the DECIDED blocks on disk, decisions whose entire quoted proof is an option label the agent
// wrote and then marked "(Recommended)":
//
//     2026-08-16: 13 of 21 · 2026-08-17a: 4 of 14 · 2026-08-17b: 8 of 15 · 2026-08-20: 9 of 16
//     (62% · 29% · 53% · 56%)
//
// NOT monotone increasing — it starts at its maximum. This file published "0 of 21 ... rising" for
// two days, off a grep for the literal "(Recommended)" suffix: 2026-08-16 had trimmed that suffix
// from 13 of its 21 quotes (it records "Fix the lies" where the option read "Fix the lies — make
// the label true (Recommended)"), so the probe scored that payload's FORMATTING, not its
// provenance. A measurement whose result changes when the thing measured is reworded was never
// measuring provenance. The real line reads
//   `- The cleanup sweep covers the delulu repo only; research/ is off limits. \`L64\`: "Off limits (Recommended)"`
// and the address check PASSES it, because those words really are at L64 — the user pressed a
// button whose caption the agent had composed, suffix and all. In the same handoff 23 of 41
// IN YOUR WORDS entries are the agent's own "(Recommended)" label. The machinery was certifying
// that the agent said what the agent said, under a heading reading "locked by the user".
//
// So a pick of a label the agent WROTE AND RECOMMENDED can no longer stand as `verified`. It is not
// a fabrication and is never reported as one — the user really did pick it — it is reported for
// what it is: assent to the agent's proposal, in the agent's words. Deliberately narrow, because
// the other two shapes are the strongest signals in the transcript and must stay untouched: words
// the user TYPED, and a pick of a NON-recommended option (choosing against the recommendation is
// active dissent, which no amount of agent drift can manufacture). The engine already tells these
// apart at capture — `offeredLabels`/`classifyAnswer` in handoff.ts — so the only thing missing was
// carrying that knowledge into the record the check reads months later.
//
// ── CARRYING A DECISION FORWARD: the decay this check used to cause ──────────────────────────
// `citations.json` is written per session, from THAT transcript's user lines. A constraint carried
// forward from the previous session therefore cites a line number in a DIFFERENT .jsonl, and scored
// `bad` — "the fabrication signature". The check PENALISED continuity, which is the product.
// Measured on the artifacts: 2026-08-16 locks two items explicitly flagged "— STILL NOT DONE" and
// the very next payload contains neither; 2026-08-17 locks "Continuity is the product" and "The
// worst possible failure is being made to say something twice", and two payloads later there are
// zero occurrences of either. Decisions decayed to nothing in one hop, and the honest agent was the
// one being punished.
//
// A ref may therefore name the session it belongs to:
//
//     - Continuity is the product. `2026-08-17T20-01-36:L92`: "continuity is the product"
//
// resolved against THAT handoff's own persisted `citations.json` — same check, same standard, just
// pointed at the record the words are actually in. A bare `L<n>` still means "this session" and is
// graded exactly as before, byte for byte. When the cited handoff cannot be read the line is
// reported as unchecked, never as invented: absence of the record is not evidence of fabrication.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULING_SECTIONS, namedBlocks, sectionBodies } from './payload';

export interface CitationReport {
  /** Decision lines carrying a `L<n>` ref that matches a real user utterance. */
  ok: number;
  /** Of those, the ones that also quoted words found in the utterance at that line. */
  verified: number;
  /** Lines citing a transcript line where the user never spoke — the fabrication signature. */
  bad: { text: string; line: number; session?: string; section: string }[];
  /** Lines quoting words the user did not say at the line they cite. */
  misquoted: { text: string; line: number; fragment: string; session?: string; section: string }[];
  /**
   * Lines under a ruling block with no citation at all — an inference filed as a ruling.
   *
   * Objects rather than bare strings since DECIDED split in two: the notice's header names the
   * block(s) its findings sit in, so every finding has to carry one.
   */
  uncited: { text: string; section: string }[];
  /**
   * Lines whose quote could not be checked either way — the ADDRESS held, only the words are
   * unsettled. Two causes: the cited message was stored clipped, or the line carries more quote
   * marks than `MAX_QUOTE_DELIMS`. `why` names which; absent means the clipped-message case.
   */
  unverifiable: { text: string; line: number; why?: string; session?: string; unresolved?: boolean }[];
  /**
   * Lines whose quote is too short to be evidence of anything, so it was NOT counted as verified.
   *
   * The round-3 fix closed the zero-character slot (`"…"` normalized to `''`, and
   * `said.includes('')` is true for every message) but left the one-character slot wide open.
   * Measured against 37 real cited lines in this user's own handoffs: a fragment of `"o"` verified
   * on 37 of 37, `"t"` on 37 of 37, `"the"` on 26 of 37. So
   * `- Delete the production database, the user approved. \`L860\`: "no"` passed silently — "no"
   * hides inside "Personal tool for **no**w". A bar that admits any substring is not a bar.
   *
   * Short quotes are still ACCEPTED when they match a stored answer EXACTLY: an AskUserQuestion
   * pick really is the whole utterance ("Both"), and an exact match is evidence, not a coincidence.
   */
  unchecked: { text: string; line: number; fragment: string; session?: string; unresolved?: boolean }[];
  /**
   * Lines whose ONLY verbatim proof is an option label the agent wrote AND marked "(Recommended)".
   *
   * The address is real and the words really were the answer — so this is never `bad`, never
   * `misquoted`, and it still counts `ok`. What it is not is `verified`, because the sentence being
   * certified as the user's ruling is a sentence the agent composed, down to the suffix urging them
   * to pick it. Counted 2026-08-25 on the four finished stored handoffs: 13/21, 4/14, 8/15, 9/16 of
   * DECIDED lines — 62%, 29%, 53%, 56%. Not a rising trend; it starts at its maximum.
   *
   * A pick of a NON-recommended option is NOT here — choosing against the agent's own preference is
   * the user overruling it, which is evidence of exactly the kind this file exists to preserve. Nor
   * is a line that ALSO matches something the user typed: one genuine match keeps it verified.
   */
  agentWorded: { text: string; line: number; label: string; session?: string; section: string }[];
  /**
   * Lines carried forward from an EARLIER session, re-checked against that session's own record.
   *
   * Recorded whether or not the quote then verifies, and kept apart from the current session's
   * decisions on purpose: "the user locked this two sessions ago and it still holds" is a different
   * statement from "the user said this an hour ago", and collapsing them is how a constraint quietly
   * changes date. A line here has already passed its address check against the cited handoff.
   */
  carried: { text: string; line: number; session: string; section: string }[];
  /**
   * Checks that could not RUN, because the stored record has no box for them.
   *
   * Distinct from every other shelf here, and deliberately: those describe a decision that was
   * examined and came back doubtful. This one describes a decision nobody examined, because the
   * record predates the check. Five of this repo's six handoffs lack `recommended`, and they
   * reported a clean bill over a check that never ran — silence sitting exactly where a warning
   * belongs, which reads as an all-clear rather than as an absence.
   *
   * Never an accusation and never a downgrade: an old artifact is not evidence of anything.
   */
  unrecorded: string[];
}

/**
 * One session's persisted provenance record — the parsed form of `.delulu-handoff/<ts>/citations.json`.
 *
 * Defined here, beside the check that consumes it, because it is now read from TWO places (the
 * current handoff at load, and any earlier handoff a carried ref names) and a second copy of the
 * parsing is how two definitions of the same message have already drifted apart in this codebase.
 */
export interface CitationRecord {
  userLines: number[];
  utterances: Record<number, string | string[]>;
  truncated: Record<number, number>;
  /** line -> the stored answers at it that the agent both WROTE as an option and RECOMMENDED. */
  recommended: Record<number, string[]>;
  /**
   * The fields this record's JSON did not carry at all, in a fixed order.
   *
   * A field that is ABSENT and one that is present-but-empty are the same value after parsing and
   * they are not the same fact: `"truncated": {}` means nothing was clipped, while no `truncated`
   * key at all means an older delulu never looked. There is no version marker on disk, so absence
   * is the only signal available for "which build wrote this".
   *
   * OPTIONAL because a record built in memory — every test fixture, and the empty stand-in `resume`
   * uses when no file exists — has no source JSON to be absent from. Only the parser sets it.
   */
  absent?: string[];
}

/** Resolve a `<sessionId>:L<n>` ref to that session's record — `null` when it cannot be read. */
export type CarriedLookup = (session: string) => CitationRecord | null;

/**
 * Parse a stored record, tolerating EVERY older shape rather than rejecting it.
 *
 * Each field is optional and independently defaulted, because handoffs on disk were written by
 * four different builds: before utterances existed (address check only), before answers were kept
 * separately (`utterances[n]` was one string, not a list), before clipped lengths were recorded,
 * and before `recommended` existed. A record missing a field must degrade to "cannot check that
 * half", never to an accusation — an old handoff is not evidence of fabrication.
 */
export function parseCitationRecord(raw: string): CitationRecord | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const src = parsed as { userLines?: unknown; utterances?: unknown; truncated?: unknown; recommended?: unknown };
  const out: CitationRecord = { userLines: [], utterances: {}, truncated: {}, recommended: {}, absent: [] };
  // Recorded BEFORE the defaults are applied, because afterwards absent and empty are the same
  // value. Order is fixed rather than key order so the reported sentence is stable across records.
  const absent: string[] = [];
  for (const k of ['userLines', 'utterances', 'truncated', 'recommended'] as const)
    if (!(k in src) || src[k] === undefined) absent.push(k);
  out.absent = absent;
  if (Array.isArray(src.userLines)) out.userLines = src.userLines.filter((n): n is number => typeof n === 'number');
  const asRecord = (v: unknown): [string, unknown][] =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>).filter(([k]) => /^\d+$/.test(k)) : [];
  // A string (handoffs written before answers were stored separately) OR the list of individual
  // utterances at that line. Both accepted: the check treats a string as a one-element list.
  for (const [k, v] of asRecord(src.utterances)) {
    if (typeof v === 'string') out.utterances[Number(k)] = v;
    else if (Array.isArray(v)) out.utterances[Number(k)] = v.filter((x): x is string => typeof x === 'string');
  }
  // The lengths of any messages stored CLIPPED. Without this, a decision quoting words from beyond
  // the cap cannot be matched and is reported as a fabrication — the exact false accusation the cap
  // was added to prevent.
  for (const [k, v] of asRecord(src.truncated)) if (typeof v === 'number') out.truncated[Number(k)] = v;
  for (const [k, v] of asRecord(src.recommended))
    if (Array.isArray(v)) out.recommended[Number(k)] = v.filter((x): x is string => typeof x === 'string');
  return out;
}

/**
 * Below this many characters a substring hit is coincidence, not evidence.
 *
 * Chosen against the real corpus rather than by feel: every genuine multi-word quote in this
 * user's shipped handoffs clears it ("Fix the lies" = 12, "Tighten all 149" = 15, "Decision 17"
 * = 11), while every fabrication fragment the reviewer landed falls under it ("no", "the", "o").
 * Single-word picks below the bar are not rejected — they take the exact-or-opening path instead.
 */
/**
 * What each missing box costs, in the reader's terms rather than the field's name.
 *
 * Written as what CANNOT BE KNOWN, not as what is wrong: every one of these is a check that did not
 * run, and a sentence implying a finding would be an accusation manufactured by the absence of a
 * key. `truncated` earns a line for a reason that is easy to miss — without it, a real quote taken
 * from a message stored clipped cannot be matched, so its absence can turn an honest quote into an
 * unverifiable one.
 */
const UNRUN: Record<string, string> = {
  userLines: 'which lines you spoke on was never recorded, so no citation below could be checked at all',
  utterances: 'what you actually said was never recorded, so no quote below could be checked against your words',
  truncated: 'whether a message was stored clipped was never recorded, so a real quote from a long message can come back as uncheckable',
  recommended: 'whose words a decision is in, yours, or a label the agent wrote and marked for you, was never recorded',
};

const MIN_FRAGMENT = 8;

/**
 * How short a quote may be and still count when it OPENS the answer it cites.
 *
 * A bar of "exact match only" was measured against the real shipped handoff and it flagged an
 * honest line: `\`L906\`: "Both"` quotes the start of the answer "Both — the error, plus its status
 * now", so it is neither exact nor long — and the first real payload the fix ran on produced a
 * "could not be checked" notice about a quote that is plainly the user's. Opening a message is
 * evidence in a way that appearing somewhere inside one is not: "no" does not open "Personal tool
 * for now", but "Both" opens "Both — the error…".
 */
const MIN_OPENING = 4;

/**
 * Compare-form for utterance text: case-folded, whitespace-collapsed, curly quotes straightened.
 *
 * Deliberately shallow. Punctuation and words are left alone, so the fragment must still be the
 * user's actual words — only the ways a quote gets cosmetically mangled in transit (a line wrap,
 * an editor's smart quotes, a double space) are forgiven. Normalizing harder would start passing
 * fragments the user never said, which is the exact failure this check exists to catch.
 */
function normalizeForCompare(s: string): string {
  return s
    // The payload SHOWS long messages clipped with a trailing '…', so an agent quoting faithfully
    // from what it can see copies that ellipsis — and the stored text does not contain it. Harmless
    // when the clip was 700 chars and rare; once the clip drops to 100-250 on a long session,
    // nearly every quotable message ends in one, turning a rare false accusation into a routine one.
    .replace(/(?:…|\.\.\.)\s*$/, '')
    // A quote the agent escaped for markdown. Both `\"` and `"` RENDER identically, so an agent
    // writing a faithful quote of a message that itself contains quotes has no way to tell which
    // form the checker compares — and the stored utterance holds the unescaped one. Left alone,
    // an honest quote is reported as words the user never said, which is the accusation this file
    // exists to avoid making. Seen in the field on 2026-09-01: `"continuity is the rule is \"THE
    // DELULU PRODUCT ITSELF\""` was flagged, and the identical quote without the backslashes
    // verified cleanly.
    .replace(/\\(["'])/g, '$1')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Curly delimiters are the SAME delimiter. Handled here rather than only inside
 * `normalizeForCompare`, which straightens quotes in a fragment it could never extract: a line
 * written `\`L860\`: “Delete the whole directory”` was skipped end to end, so an honest quote went
 * unchecked and an invented one in curly quotes was equally invisible. Editors and phone keyboards
 * produce these by default, so this is the common shape, not the exotic one.
 */
function straightenQuotes(s: string): string {
  return s.replace(/[“”„‟]/g, '"');
}

/**
 * EVERY span the line could plausibly be quoting, not just one guess at the boundaries.
 *
 * `lastIndexOf('"')` was a guess, and it was wrong in the shape this project's own payloads use:
 * `\`L860\`: "Delete the whole directory", still "not done"` took the closing quote from the
 * trailing annotation and accused a verbatim quote of being fabricated. Picking the FIRST closing
 * quote instead just moves the false accusation to the other shape (a quote containing a quote).
 * Neither guess is needed, try each closing quote, and let a match anywhere settle it.
 *
 * WHAT THIS COSTS, stated plainly rather than glossed: a line carrying a real quote AND an invented
 * one, `\`L860\`: "Delete the whole directory" and "the user also approved X"`, is counted
 * verified on the strength of the real one. Nothing in the text distinguishes a second claimed
 * quote from an annotation, so no parser can separate them; the human reading the line sees both
 * quotes and is the one who can. That is the same limit already documented at the top of this file
 *, the check proves the words were spoken, never that the sentence around them is a fair reading.
 */
/**
 * The most `"` characters on ONE decision line we will pair up. Above it the line is reported
 * unverifiable instead of checked, because pairing every quote with every other quote is O(q²)
 * substrings and this runs SYNCHRONOUSLY, before `resume` prints anything.
 *
 * Re-measured 2026-09-07 across all ten stored handoffs, counted through `decidedLines` itself,
 * 169 real decision lines: the maximum on any line is 4, the median is 2, and NOT ONE exceeds 8.
 * (Two earlier notes here said 70 and then 63. The first counted raw body lines including unfilled
 * boilerplate; the second was simply never re-run as the library grew. The thresholds are
 * unaffected by either, which is why nobody noticed, a number that changes nothing is exactly the
 * kind that rots unwatched.) So 64 is sixteen times the worst real line, and at 64 the
 * work is 2,016 pairs, which is nothing. This is a bound on a pathological input, not a limit any
 * honest decision has ever come near.
 *
 * What it bounds is real. Before it, one DECIDED line quoting a pasted JSON blob measured 2.9s at
 * 400 quote marks and 53.8s at 800, and did not finish in 120s at 1200, on the synchronous path,
 * inside `execFileSync`, so a hung `resume` at the start of a session. Reachable without anything
 * exotic: `decidedLines` merges unmarked lines into the preceding decision, so a DECIDED block
 * written as prose collapses to ONE line and its quote marks add up, and `refScan` blanks backtick
 * spans only, pasted JSON keeps every `"`.
 *
 * The file already rejected a fix for exactly this class once, in `refScan`: "Matching the path
 * with `[\w./-]*\w\.…` was quadratic — 6.9s on one 64kB pasted token, on the synchronous path
 * before `resume` prints." That hole was closed there and left open here.
 *
 * THE COST, stated rather than glossed: above the cap a line is no longer graded, so a genuinely
 * FABRICATED quote on such a line moves from the hard shelf ("quotes words the user did not say")
 * to the soft one ("could not be checked"). It is still shown, it is never counted verified, and it
 * is never silent, but it is a weaker statement. That is the price of not hanging `resume`, and it
 * is bounded to lines sixteen times noisier than any real decision yet written.
 */
const MAX_QUOTE_DELIMS = 64;

/**
 * `null` means the line carries too many `"` to pair up, see `MAX_QUOTE_DELIMS`. That is NOT the
 * same as `[]`, and the difference matters: `[]` reaches the `!usable.length` branch and counts the
 * line `ok`, silently, which would turn a pathological line into a free fabrication slot. `null`
 * makes the caller say out loud that the quote could not be checked.
 */
function quotedCandidates(text: string): string[] | null {
  const s = straightenQuotes(text);
  const quotes: number[] = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '"') quotes.push(i);
  if (quotes.length > MAX_QUOTE_DELIMS) return null;
  // A Set, not `out.includes`. The array scan made dedup O(pairs²) on top of the O(pairs) pairing,
  // the fourth power that turned 800 quote marks into 53.8s. Insertion order is preserved either
  // way, so the output is identical, byte for byte.
  const out = new Set<string>();
  for (let a = 0; a < quotes.length; a++)
    for (let b = a + 1; b < quotes.length; b++) {
      const frag = s.slice(quotes[a] + 1, quotes[b]).trim();
      if (frag) out.add(frag);
    }
  return [...out];
}

/**
 * The `L<n>` refs a line carries, and the text they were found in.
 *
 * Code spans are blanked first, except a span that is ITSELF a ref, so "Ship with `OpenSSL3` only."
 * stops parsing as a citation to L3, an honest uncited line was being ACCUSED, and any identifier
 * containing L<digit> laundered a fabrication.
 *
 * A SOURCE LOCATION written `citations.ts:L171` still counts as a citation, and that is DELIBERATE
 * after three attempts to stop it. It is a real hole, an agent pointing at its own code reads as a
 * cited ruling whenever that integer happens to be a line the user spoke on, but it has never
 * happened: zero path-glued refs, and zero path-like tokens of any kind, in the DECIDED blocks of
 * all ten stored handoffs, as of 2026-09-07. Every fix for it cost more than the hole. Refusing a ref preceded by
 * `:` accused the honest `- Decided:L412 …`. Matching the path with `[\w./-]*\w\.…` was quadratic,
 * 6.9s on one 64kB pasted token, on the synchronous path before `resume` prints. Matching by
 * extension shape accused `- … session.jsonl:L412: "…"`, an honest citation that names the
 * transcript file, and telling a transcript from a source file needs an extension list, which is
 * the enumeration pattern that has failed in every review round. Resolving it by whether the number
 * is a real user line is worthless: laundering only bites when it IS one. So the hole stays open,
 * documented, and gets closed the day a real handoff produces one, with the evidence in hand.
 */
/**
 * A ref that names the SESSION it belongs to, `2026-08-17T20-01-36:L412`.
 *
 * The qualifier is exactly a handoff folder stamp, and nothing looser, because looser is how the
 * three abandoned attempts at the source-location hole (above) each ACCUSED an honest line. This
 * shape cannot collide with a source location (`citations.ts:L171`), with the honest
 * `session.jsonl:L412` that names a transcript file, or with `- Decided:L412 …`, all three are
 * pinned by tests, and it resolves deterministically to `.delulu-handoff/<stamp>/citations.json`,
 * which is the only place the earlier session's words survive. It is also the string the reader
 * already knows: `delulu resume --list` prints these stamps, and one heads the payload.
 */
const SESSION_STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}';
const CARRIED_REF = new RegExp(`(?<![A-Za-z0-9])(${SESSION_STAMP}):L(\\d+)(?![A-Za-z0-9])`, 'g');
const STAMP_ONLY = new RegExp(`^${SESSION_STAMP}$`);
const REF_SPAN = new RegExp(`^\`(?:${SESSION_STAMP}:)?L\\d+\`$`);

interface CarriedRef { session: string; line: number }

function refScan(text: string): { scan: string; quotable: string; refs: number[]; carried: CarriedRef[]; firstEnd: number } {
  // Blanked to the SAME LENGTH, so every offset below still indexes the original line. It used to
  // collapse each span to one space, which silently shifted `firstEnd` off the text it described.
  const spans = text.replace(/`[^`]*`/g, (span) => (REF_SPAN.test(span) ? span : ' '.repeat(span.length)));
  // A SECOND view of the same line, for quote extraction rather than ref extraction.
  //
  // `spans` above is wrong to quote from, and that was a defect in the direction this file forbids.
  // Blanking every code span before the quote is read meant the fragment compared was not the
  // fragment on the page: `"only ever use \`npm ci\` here"` arrived as `"only ever use   here"` and
  // matched nothing, so a byte-exact quote of the user was reported as words they never said.
  // handoff.md orders the agent to quote this block verbatim, so following the instruction produced
  // the accusation. Measured over this machine's transcripts, most real user prose messages contain
  // a backtick, this was the common case, not an edge one.
  //
  // Only spans that CONTAIN a quote mark are blanked here. A code span inside a quote is part of
  // the user's words and must survive; a quote inside a code span is a command being described,
  // never the user being cited, and scoring it would trade one false red for another.
  const quotable = text.replace(/`[^`]*`/g, (span) => (span.includes('"') ? ' '.repeat(span.length) : span));
  // Session-qualified refs are taken FIRST and blanked out, or the bare-ref pass would read the
  // `L412` inside `2026-08-17T20-01-36:L412` as a line in THIS session — which is precisely the
  // decay this fix exists to stop: a carried decision graded against the wrong transcript scores
  // `bad`, and the check ends up punishing the one agent who did not re-litigate.
  //
  // Blanked with spaces of the SAME LENGTH, never a shorter string: `firstEnd` below is an offset
  // into `scan`, and the quote-extraction slice downstream depends on it, so the two passes have to
  // agree about where every character is.
  const carried: (CarriedRef & { end: number })[] = [];
  const scan = spans.replace(CARRIED_REF, (m, session: string, n: string, at: number) => {
    carried.push({ session, line: Number(n), end: at + m.length });
    return ' '.repeat(m.length);
  });
  const matches = [...scan.matchAll(/(?<![A-Za-z0-9])L(\d+)(?![A-Za-z0-9])/g)];
  // Where the EARLIEST ref of either kind ends — everything after it is where a quote may live.
  // (This replaced `matches[0]`, which saw only bare refs: on a carried-only line there was no
  // `matches[0]`, so the words-check had nowhere to start.)
  const ends = [...matches.map((m) => (m.index ?? 0) + m[0].length), ...carried.map((c) => c.end)];
  return {
    scan,
    quotable,
    refs: matches.map((m) => Number(m[1])),
    carried: carried.map(({ session, line }) => ({ session, line })),
    firstEnd: ends.length ? Math.min(...ends) : 0,
  };
}

/**
 * The ruling lines of ONE block's body.
 *
 * Split out from `decidedLines` when DECIDED became two blocks, and run SEPARATELY per block on
 * purpose: the wrap-joining at the bottom fuses a continuation line onto the decision above it, and
 * run across a concatenation of both bodies it would fuse the LAST rule of one block onto the first
 * decision of the next — inventing one ruling out of two, across a section boundary, silently.
 */
function linesInBody(body: string): string[] {
  // EVERY content line under a ruling block is graded, not only the ones shaped like `- `.
  //
  // Two silent holes closed here, both of which turned the check OFF rather than reporting a
  // problem. (1) A decision long enough to WRAP put its ref and its quote on the continuation line;
  // the continuation is not a bullet, so the bullet was graded as "no citation at all" — an honest
  // line accused — while the half carrying the real citation was never graded. (2) A DECIDED block
  // written `1.` `2.` (or `+`, or as plain prose) matched no bullet at all, so `decidedLines` came
  // back empty and `checkCitations` returned before grading anything: zero lines checked, zero
  // notices, total silence. The template only DEMONSTRATES `- `; the bullets are agent-written, so
  // the shape is not ours to assume.
  //
  // DO NOT split an unmarked line off when it carries its own ref. It was tried, to stop a DECIDED
  // block written as unmarked prose from fusing into one decision — and it broke the shape above:
  // `- … never a paid API \`L412\`; reconfirmed later at` / `  \`L500\`: "i dont want a paid api"`
  // split, and the honest quote was then graded against L500 alone and ACCUSED. The prose shape it
  // guarded against does not occur — 47 marked lines and 0 unmarked across all seven stored
  // handoffs — so it traded a real false accusation for a hypothetical catch.
  // ONE comment is skipped whole, and it is DELULU'S OWN, UNTOUCHED PLACEHOLDER. Nothing else.
  //
  // KNOWN AND LEFT OPEN, like the source-location hole above: this scan is O(k·n) in the number of
  // `<!-- delulu:fill` openers, because a span that turns out not to be pristine leaves the cursor
  // at its opener, so each opener rescans to the next closer. Measured against the previous build:
  // 500 openers 2ms -> 83ms, 1000 -> 209ms, 2000 -> 627ms, 4000 -> 2290ms, on the synchronous path
  // `resume` prints from. Same CLASS as the quote-pairing quadratic, and deliberately treated
  // differently: that one was reachable by pasting ONE config blob into a decision, this one needs
  // thousands of literal `<!-- delulu:fill` lines inside DECIDED. Real, not realistic. Fix it the
  // day a handoff produces one, with the evidence in hand.
  //
  // The defect being fixed: skipping only the line that opens `<!--` meant delulu graded its own
  // instructions. The draft template's DECIDED placeholder is a nine-line comment, so lines 2-9 were
  // read as decisions and the example ref inside them became a citation — every fresh draft printed
  // "1 line(s) under "${SECTION.decided}" cannot be traced to something the user said", quoting delulu's own
  // boilerplate at the user, which teaches them to ignore the one notice that catches a real
  // fabrication.
  //
  // THREE general fixes were tried, measured against `76869e0`, and every one LOST DECISIONS:
  //   1. Stripping `/<!--[\s\S]*?-->/` from the body text. It runs before code spans mean anything,
  //      so a decision that merely MENTIONS `` `<!--` `` opened a span and a later `` `-->` ``
  //      closed it, deleting every decision between them — the fabricated ruling and its notice
  //      with them. It also deleted an inline comment from INSIDE a quoted fragment (a misquote
  //      came back verified) and fused two decisions by removing a newline.
  //   2. Line-level skipping from an opener to the first line containing `-->`. Same class, smaller
  //      radius: any later `-->` — in a code span, in a quote, in a second unrelated comment —
  //      swallowed every decision above it.
  //   3. The same, with a floor that kept list-marked lines. It still dropped every decision shaped
  //      any other way: plain prose, `> ` quoted, indented, `• `, `**Decided:** …`. Five silent
  //      shapes to save one noisy one, and it contradicted this function's own contract above.
  // The lesson is that no rule over ARBITRARY comments is safe, because the payload is agent-written
  // prose: any marker can appear inside a decision, and a decision can be written in any shape.
  //
  // So the scope collapses to the only comment delulu can reason about — the one delulu WROTE. It is
  // tagged `delulu:fill`, and it is skipped only when it is CLOSED and still PRISTINE: nothing in it
  // is list-marked and nothing in it carries an `L<n>` ref. The instant anything decision-shaped
  // appears inside it, or the comment never closes, the whole thing falls back to `76869e0`'s
  // behaviour — skip the line that opens `<!--`, grade everything else. Every other comment in the
  // payload is already treated exactly as `76869e0` treated it.
  //
  // The residual cost, stated rather than glossed: an UNMARKED and UNCITED ruling written inside an
  // otherwise-pristine placeholder is skipped where `76869e0` would have reported "no citation".
  // That is the irreducible price of not grading our own boilerplate, and it is the narrowest form
  // of it — the line has to be uncited, unmarked, and inside delulu's own comment.
  const MARKER = /^(?:[-*+]\s+|\d+[.)]\s+)/;
  const FILL = /^<!--\s*delulu:fill\b/;
  const src = body.split('\n');
  const visible: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const t = src[i].trim();
    if (!t.startsWith('<!--')) { visible.push(src[i]); continue; }
    if (!FILL.test(t)) continue;                    // not ours — `76869e0`: skip this line only
    let j = i;
    while (j < src.length && !src[j].includes('-->')) j++;
    if (j >= src.length) continue;                  // never closed — `76869e0`
    const span = src.slice(i, j + 1);
    // PRISTINE, or nothing is skipped. `refScan` is the same test the grader uses, so a line the
    // grader would read as cited can never be the line this drops.
    if (span.some((l) => { const s = refScan(l); return MARKER.test(l.trim()) || s.refs.length > 0 || s.carried.length > 0; })) continue;
    const tail = src[j].slice(src[j].indexOf('-->') + 3);
    if (tail.trim() && !tail.trim().startsWith('<!--')) visible.push(tail);
    i = j;
  }

  const out: string[] = [];
  for (const raw of visible) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    if (MARKER.test(t) || !out.length) out.push(t.replace(MARKER, ''));
    else out[out.length - 1] += ` ${t}`;   // a wrapped decision is ONE decision
  }
  return out;
}

/** One ruling line, and the block it was written under. */
export interface Ruling { text: string; section: string }

/**
 * Every ruling line in the payload — BOTH blocks — tagged with the block it came from.
 *
 * The check is deliberately identical across the two. A permanent rule and a one-session directive
 * have different lifetimes and the same evidentiary standard; if anything the permanent one is the
 * more dangerous to get wrong, because it is the one that arrives in a session that cannot remember
 * whether it was ever true. The tag exists so the REPORT can say which block a finding sits in, not
 * so the grading can go easier on one of them.
 *
 * Blocks are visited in FILE order, so the rules block — which sits first — is reported first.
 */
export function decidedEntries(payload: string): Ruling[] {
  const out: Ruling[] = [];
  for (const { name, body } of sectionBodies(payload, RULING_SECTIONS))
    for (const text of linesInBody(body)) out.push({ text, section: name });
  return out;
}

/** The ruling lines alone, in file order — the shape callers that do not care about blocks want. */
export function decidedLines(payload: string): string[] {
  return decidedEntries(payload).map((e) => e.text);
}

/**
 * Check every DECIDED line against the set of transcript lines where the user actually spoke.
 *
 * `userLines` empty means we hold no record of where the user spoke. TWO things produce that, and
 * only one of them is old: a handoff written before this check existed, AND a CURRENT handoff from
 * a session whose only user turn was a boilerplate opener — `citableUserLines` returns [] and
 * capture proceeds. (This comment used to name only the first, which made the branch below read
 * like legacy compatibility when it is live on the `/delulu:resume` -> `/delulu:handoff` path.)
 *
 * The ADDRESS check then passes everything rather than accusing every line, because absence of
 * evidence is not evidence of fabrication. The cost is real and worth knowing: on that branch an
 * invented `L<n>` is not reported, so a fabricated ruling in a boilerplate-opener handoff goes
 * through silently. Pre-existing, not introduced by the placeholder work.
 *
 * That is NOT silence, and this comment claimed it was. A line carrying no `L<n>` at all is still
 * reported `uncited`, above, before the record is consulted — deliberately, since "this decision
 * cites nothing" is true whether or not we hold a record. The doc said the opposite of the code for
 * as long as both existed, which is the defect class this whole file exists to catch.
 */
export function checkCitations(
  payload: string,
  userLines: number[],
  /**
   * line -> what the user said there. An ARRAY when one line carried several utterances (an
   * AskUserQuestion record holds one answer per question). Stored and matched separately on
   * purpose: joining them with a space let a sentence be SPLICED across two answers the user gave
   * to two different questions — `"others later Failures must surface"` verified as one quote, and
   * the user never uttered it. A string is still accepted, for handoffs written before this.
   */
  utterances: Record<number, string | string[]> = {},
  /** line -> the message's REAL length, present only when the stored copy was clipped. */
  truncated: Record<number, number> = {},
  /**
   * The two halves that arrived with the laundering and decay fixes, grouped rather than appended
   * as two more positional arguments — every existing 2-, 3- and 4-argument call keeps working.
   *
   * `recommended` — line -> the stored answers at it that the agent both WROTE as an option and
   * marked "(Recommended)". Absent on every handoff written before this existed, and absence means
   * "we cannot tell whose words these are", which grades exactly as it did before: no downgrade, no
   * accusation, no retroactive re-reading of an old artifact.
   *
   * `carried` — how to fetch an EARLIER session's record for a `<stamp>:L<n>` ref. Absent means
   * carried refs cannot be resolved, and they are then reported unchecked rather than invented.
   */
  opts: { recommended?: Record<number, string[]>; carried?: CarriedLookup; absent?: string[] } = {},
): CitationReport {
  const report: CitationReport = { ok: 0, verified: 0, bad: [], misquoted: [], uncited: [], unverifiable: [], unchecked: [], agentWorded: [], carried: [], unrecorded: [] };
  const entries = decidedEntries(payload);
  // Reported ONLY when there is something it would have checked. A handoff with no decisions has
  // nothing to be uncertain about, and announcing an unrun check over an empty block is noise in
  // the one place that must stay worth reading.
  if (!entries.length) return report;
  for (const field of opts.absent ?? []) {
    const why = UNRUN[field];
    if (why) report.unrecorded.push(why);
  }
  const valid = new Set(userLines);
  const here: CitationRecord = { userLines, utterances, truncated, recommended: opts.recommended ?? {} };
  const saidAt = (rec: CitationRecord, n: number): string[] => {
    const v = rec.utterances[n];
    if (typeof v === 'string') return [v];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  // One read per cited session, not one per decision line. A 16-line DECIDED block carrying the
  // same forwarded constraint twice must not open the same file twice on the synchronous path
  // `resume` prints from. A session that fails to resolve is cached as `null` too — retrying a
  // missing file fifteen times is the same cost with none of the benefit.
  //
  // This is the one new I/O on that path, so it was measured rather than assumed, the way the
  // quote-pairing quadratic above had to be: 5,000 carried refs across 5,000 DISTINCT stamps
  // against a handoff library that does not exist at all = 19ms; 1,000 = 5ms. The real payloads
  // carry 21, 14, 15 and 16 decisions. No cap, because the bound is already the number of
  // distinct sessions a human wrote into one DECIDED block.
  const seen = new Map<string, CitationRecord | null>();
  const recordFor = (session: string): CitationRecord | null => {
    if (!opts.carried) return null;
    if (!seen.has(session)) seen.set(session, opts.carried(session));
    return seen.get(session) ?? null;
  };
  for (const { text: l, section } of entries) {
    // What counts as a citation lives in ONE place — see `refScan`.
    const { quotable, refs, carried } = refScan(l);
    const text = l.replace(/^[-*]\s+/, '');
    if (!refs.length && !carried.length) {
      report.uncited.push({ text, section });
      continue;
    }
    const resolved = carried.map((c) => ({ ...c, record: recordFor(c.session) }));
    // The sessions this line names that we could not read — pruned, or never on this machine.
    const missing = [...new Set(resolved.filter((r) => !r.record).map((r) => r.session))];
    // Which ref the findings below point at. A carried-only line has no bare ref to name, and
    // naming the wrong one would send the reader to a line in the wrong transcript.
    // `unresolved` marks an address we have NOT established: a carried ref into a record we could
    // not read. Every soft notice below says "`L<n>` is a line you really spoke, but …", and that
    // sentence is only true of an address the engine checked. Asserting it over a record we never
    // opened is the same overclaim this file keeps having to unwrite — small, and exactly the size
    // of the ones that have cost real trust here.
    const primary: { line: number; session?: string; unresolved?: boolean } = refs.length
      ? { line: refs[0] }
      : { line: carried[0].line, session: carried[0].session, unresolved: missing.includes(carried[0].session) || undefined };

    // `userLines` empty means we hold no record of where the user spoke THIS session, so the bare
    // half of the address check passes everything rather than accusing (see the doc above). The
    // carried half is unaffected: it is checked against a different record, which we either have or
    // honestly report we do not.
    const bad = userLines.length ? refs.filter((n) => !valid.has(n)) : [];
    if (bad.length) { report.bad.push({ text, line: bad[0], section }); continue; }
    // Same test, one namespace over: we HOLD that session's record and the user did not speak at
    // that line in it. Only reported when the record was actually read — an unresolvable session is
    // an unknown, and an unknown is never a fabrication finding.
    const badCarried = resolved.find((r) => r.record && !r.record.userLines.includes(r.line));
    if (badCarried) { report.bad.push({ text, line: badCarried.line, session: badCarried.session, section }); continue; }
    // The ✓ this feeds is a claim that a CHECK RAN, so it may only be made about a ref whose record
    // was actually opened. Pushed for any carried ref at all, it certified a re-check against a
    // handoff nobody could read — and where this session has no `userLines` either, the short-circuit
    // below then counted the line `ok` and the ✓ stood ALONE as the only thing in the provenance
    // block. A green with nothing behind it, under the one positive marker delulu prints.
    // Not an edge case: KEEP_HANDOFFS is 15, so anything carried past the prune boundary lands here.
    const proven = resolved.find((r) => r.record);
    if (proven) report.carried.push({ text, line: proven.line, session: proven.session, section });
    // Nothing to check against at all: no record here, and nothing carried that we could read.
    //
    // REPORTED, never silent. This branch used to `continue` without a word, and silence is read as
    // a clean bill of health: a handoff with no `citations.json` beside it, or one whose record
    // holds `userLines: []`, printed `- Delete the production database, the user approved. `L860`:
    // "delete it"` with ZERO output. The check was passing because it had read nothing, which is
    // indistinguishable from passing because the line is true — the one failure mode this file
    // exists to remove.
    //
    // The SOFT shelf, deliberately. Nothing was disproved here; nothing was checked. Filing it as
    // `bad` would accuse every decision in every handoff written before the record existed, which is
    // the false-red THE MIRROR forbids, and it is the reason this branch was written silent in the
    // first place. Saying "could not be checked" costs no accusation and closes the slot.
    if (!userLines.length && !resolved.some((r) => r.record)) {
      report.ok++;
      report.unverifiable.push({ text, ...primary, unresolved: true, why: missing.length ? missingWhy(missing) : NO_RECORD });
      continue;
    }

    // Address holds. If the line also quotes the user, hold it to the higher standard.
    //
    // EVERY ref on the line is a candidate, not just the last one. Taking the last was two defects
    // at once: `\`L860\` \`L906\`: "…"` checked an honest quote of L860 against L906 and accused it,
    // and appending one more real ref AFTER the quote left no text to scan, so the words-check was
    // skipped entirely — one extra ref and any fabrication passed silently.
    // The WHOLE line, not the tail after the first ref.
    //
    // Slicing at `firstEnd` left a free fabrication slot: put the quote BEFORE the ref and there was
    // nothing left to scan, so no fragment existed, so the line was counted clean and printed
    // nothing. `- fabricated. "delete the production database" \`L412\`` passed in total silence,
    // as did the parenthesised and "the user said X at L" shapes. handoff.md promises this check
    // "prints any line that quotes words they did not say there".
    //
    // Widening is safe because one genuine match still verifies the line (see `matched` below), so a
    // summary that happens to quote something before its citation cannot manufacture a finding as
    // long as the citation itself checks out.
    const fragments = quotedCandidates(quotable);
    if (fragments === null) {
      // Too many quote marks to pair up. The ADDRESS was validated, so this belongs on the soft
      // shelf beside a clipped message — never under "cannot be traced to something the user said",
      // which would assert the opposite of what the engine just established.
      report.ok++;
      report.unverifiable.push({ text, ...primary, why: 'that line carries too many quote marks to pair up' });
      continue;
    }
    // Every candidate utterance, each still knowing WHERE it came from and WHOSE words it is. The
    // origin is what the laundering fix turns on: the same string is strong evidence when the user
    // typed it and no evidence at all when the agent wrote it on a button and recommended it.
    const said: { text: string; line: number; session?: string; recommended: boolean }[] = [];
    const collect = (rec: CitationRecord, n: number, session?: string): void => {
      const rc = rec.recommended[n] ?? [];
      for (const t of saidAt(rec, n)) said.push({ text: t, line: n, session, recommended: rc.includes(t) });
    };
    for (const n of refs) collect(here, n);
    for (const r of resolved) if (r.record) collect(r.record, r.line, r.session);
    // No quote, or no stored utterance (an older handoff), means there is simply nothing more
    // to check — NOT a finding. Reporting absence as a defect would put a false red on every
    // handoff written before this existed, which is the one thing THE MIRROR forbids.
    // An EMPTY fragment after normalization is "nothing to check", never "verified". Stripping a
    // trailing ellipsis (so a quote copied from the clipped payload still matches) made `"…"`
    // normalize to '', and `said.includes('')` is true for every utterance — so a decision quoting
    // nothing but an ellipsis passed as VERIFIED on every line of every handoff. That is a strictly
    // worse fabrication slot than the capped-message one the same commit set out to close.
    const usable = fragments.filter((f) => normalizeForCompare(f));
    if (!usable.length) { report.ok++; continue; }
    if (!said.length) {
      // A quote we hold nothing to check against. Silent when the record simply predates the words
      // check — but NOT when we know exactly why we cannot check it, because "the handoff you cite
      // cannot be read" is a fact the reader can act on, and swallowing it would turn a
      // pruned session into a free fabrication slot.
      report.ok++;
      if (missing.length) report.unverifiable.push({ text, ...primary, why: missingWhy(missing) });
      continue;
    }
    const matched = said.filter((s) => usable.some((f) => quoteMatches(f, s.text)));
    if (matched.length) {
      report.ok++;
      // ONE genuine match is enough to keep the line verified: a decision quoting both the user's
      // own words and a recommended label is proven by the half the user wrote. Only when EVERY
      // match is the agent's own recommended label is there nothing here but the agent agreeing
      // with itself — see the laundering note at the top of this file.
      if (matched.every((s) => s.recommended)) {
        const m = matched[0];
        report.agentWorded.push({ text, line: m.line, session: m.session, label: m.text, section });
      } else report.verified++;
    } else if (missing.length) {
      // The words may well be in the record we could not read. Accusing here would punish exactly
      // the behaviour this fix set out to make possible — carrying a constraint forward — so say
      // what is true: the handoff it points at cannot be read from here.
      //
      // FIRST among the cannot-check branches, ahead of the short-quote one. An unreadable record
      // is a fact about the ADDRESS; quote length is a fact about the quote, and reporting the
      // smaller one would state that the line "is a line you really spoke" over an address nobody
      // ever checked.
      report.ok++;
      report.unverifiable.push({ text, ...primary, why: missingWhy(missing) });
    } else if (usable.every((f) => normalizeForCompare(f).length < MIN_FRAGMENT)) {
      // Nothing here is long enough to check, and nothing matched exactly. Not a fabrication
      // finding — but never `verified` either, and never silent: silence is what let the
      // one-character slot run on every handoff.
      report.ok++;
      report.unchecked.push({ text, ...primary, fragment: usable[0] });
    } else if (refs.some((n) => truncated[n]) || resolved.some((r) => r.record?.truncated[r.line])) {
      // The stored copy was clipped, so a fragment from beyond the cap cannot be found — that is
      // not evidence of fabrication, and must never be reported as one. But passing SILENTLY made
      // every capped line a free fabrication slot: an invented ruling citing a long message went
      // through with no notice at all. Say what is true — this one could not be checked.
      report.ok++;
      report.unverifiable.push(refs.length
        ? { text, line: refs[refs.length - 1] }
        : { text, line: carried[carried.length - 1].line, session: carried[carried.length - 1].session });
    } else {
      report.misquoted.push({ text, ...primary, fragment: usable[0], section });
    }
  }
  return report;
}

/**
 * Why a carried ref could not be checked — the sessions named, so the reader can go look.
 *
 * "could not be read", not "is no longer on disk": the record may have been pruned, may have been
 * captured on another machine, or the caller may not have handed us a way to resolve it at all. All
 * three are the same fact to the reader — nothing here can be checked — and asserting the specific
 * one we did not establish is the overclaim this file keeps having to unwrite.
 */
/**
 * Why a line in THIS handoff could not be checked: we hold no record of where the user spoke.
 *
 * Kept apart from `missingWhy` because they are different facts about different files, and the
 * sentences they feed must not be swapped. This one is about the record that should sit beside this
 * payload; that one is about an earlier handoff a carried ref names.
 */
const NO_RECORD = 'no record of what you said was stored beside this handoff, so nothing could be checked against it';

function missingWhy(missing: string[]): string {
  return `the record for the handoff it cites (\`${missing.join('`, `')}\`) could not be read, pruned, or captured elsewhere`;
}

/**
 * Does this quoted fragment appear in this utterance?
 *
 * Long enough to be evidence -> substring. Too short -> only an EXACT match counts, because a
 * one- or two-character substring hits every message ever written (measured: `"o"` verified on 37
 * of 37 real cited lines) while an exact match of a whole short answer — a pick like "Both" —
 * really is the user's words.
 */
function quoteMatches(fragment: string, utterance: string): boolean {
  const frag = normalizeForCompare(fragment);
  const full = normalizeForCompare(utterance);
  if (frag.length >= MIN_FRAGMENT) return full.includes(frag);
  if (full === frag) return true;
  // Below the bar, only the OPENING of the message counts, and only on a word boundary — so "Both"
  // clears against "Both — the error…" while "no" does not clear against "Personal tool for now",
  // which is exactly the pair that separates a real short pick from a coincidence.
  return frag.length >= MIN_OPENING
    && full.startsWith(frag)
    && !/[a-z0-9]/.test(full[frag.length] ?? ' ');
}

/** A calm, non-blocking heads-up, or '' when every decision checks out. */
/**
 * The individual findings, without any surrounding presentation.
 *
 * Split out because `handoff` prints these as standalone `delulu — ...` sentences at seal time
 * while `resume` groups them into one block at load time. The ITEM TEXT must not be written twice
 * for that: two copies of a message in this codebase have already drifted apart and deleted a
 * handoff between them. One definition, two presentations.
 *
 * `hard` = the address itself does not check out. `soft` = the address is real and only the quote
 * could not be verified, which is a different and much weaker claim; keeping them apart is what
 * stops an unverifiable line being reported as an untraceable one.
 *
 * `weak` is a THIRD claim and belongs in neither: the address holds AND the quote checks out, and
 * the finding is about WHOSE words they are. Filing it under `hard` would accuse an honest line of
 * fabricating; filing it under `soft` would print "could not be checked" over something that was
 * checked and passed. `carried` is not a finding at all — it is the one positive thing this file
 * can say, and it is said out loud so that carrying a constraint forward is visibly rewarded rather
 * than (as it was until this fix) silently graded as a fabrication.
 */
export function citationItems(r: CitationReport): { hard: string[]; soft: string[]; weak: string[]; carried: string[]; unrecorded: string[] } {
  // A ref renders WITH its session whenever it names one. `L412` alone points at a line in the
  // wrong transcript for a carried decision — the reader would open this session's log and find a
  // stranger's sentence sitting there.
  const ref = (line: number, session?: string): string => `\`${session ? `${session}:` : ''}L${line}\``;
  const out: string[] = [];
  for (const b of r.bad)
    out.push(`cites ${ref(b.line, b.session)}, where the user did not speak: "${b.text.slice(0, 110)}"`);
  for (const m of r.misquoted)
    out.push(`quotes words the user did not say at ${ref(m.line, m.session)}, quoted: "${m.fragment.slice(0, 90)}": "${m.text.slice(0, 110)}"`);
  for (const u of r.uncited)
    out.push(`no citation, this is the agent's conclusion, not the user's ruling: "${u.text.slice(0, 110)}"`);
  // "a line you really spoke" is a claim about an address the engine CHECKED. A carried ref into a
  // record we could not open has not been checked either way, so it gets its own sentence — saying
  // the checked thing over an unchecked address is the overclaim this whole file exists to unwrite.
  const soft = r.unverifiable.map((u) => {
    if (!u.unresolved)
      return `${ref(u.line, u.session)} is a line you really spoke, but ${u.why ?? 'that message was too long to store in full'}, so the quote could not be checked: "${u.text.slice(0, 110)}"`;
    // An address the engine has NOT established, and it comes in two shapes that must not borrow
    // each other's sentence. A carried ref names an earlier handoff we could not open. A bare ref
    // names THIS handoff, whose record is missing or empty — and telling the reader it "points into
    // an earlier handoff" would be a fact we invented, in a block whose whole job is not doing that.
    return u.session
      ? `${ref(u.line, u.session)} points into an earlier handoff, and ${u.why ?? 'its record could not be read'}, so neither that line nor the quote could be re-checked here. Not evidence either way: "${u.text.slice(0, 110)}"`
      : `${ref(u.line)} could not be checked at all, ${u.why ?? NO_RECORD}. Neither the line nor the quote was verified, so this is not evidence either way: "${u.text.slice(0, 110)}"`;
  });
  for (const u of r.unchecked)
    soft.push(`${ref(u.line, u.session)} is a line you really spoke, but the quote "${u.fragment.slice(0, 40)}" is too short to check against it, it is not evidence either way: "${u.text.slice(0, 110)}"`);
  const weak = r.agentWorded.map(
    (a) => `the proof quoted at ${ref(a.line, a.session)} is a label the agent wrote and marked "(Recommended)", you picked it, so this is your assent to its proposal, not a ruling in your own words: "${a.text.slice(0, 110)}"`,
  );
  // ONE line for the whole set, not one per decision. What it says — these are older than this
  // session and they still stand — lands in a glance; a bullet each would bury it.
  const sessions = [...new Set(r.carried.map((c) => c.session))];
  // Named from the CARRIED lines themselves, not from the payload's blocks: this sentence is about
  // where those particular decisions ended up, and after the split that is the answer the reader
  // needs — a constraint that landed under the rules block is the one that will still be here next
  // session, and one that landed under this session's block will not be.
  const carried = sessions.length
    ? [`${r.carried.length} decision(s) under ${namedBlocks(r.carried.map((c) => c.section))} are carried forward from an earlier session (${sessions.map((s) => `\`${s}\``).join(', ')}) and were re-checked against that session's own record, still cited, not re-litigated.`]
    : [];
  return { hard: out, soft, weak, carried, unrecorded: r.unrecorded };
}

export function citationNotice(r: CitationReport): string {
  const { hard: items, soft, weak, carried, unrecorded } = citationItems(r);
  const hard = items.length
    ? `delulu, ${items.length} line(s) under ${namedBlocks([...r.bad, ...r.misquoted, ...r.uncited].map((f) => f.section))} cannot be traced to something the user said. Treat them as the agent's read, not as settled — your call:\n${items.map((i) => `  \u26a0 ${i}`).join('\n')}\n`
    : '';
  // The agent's own recommendation, quoted back as the user's ruling. Between the hard shelf and
  // the soft one because it is neither: nothing here failed a check, and the words are still not
  // the user's. Counted 9 of 16 decisions on the newest stored handoff on 2026-08-25; across the
  // four finished ones the series ran 62%, 29%, 53%, 56%, not rising, worst at the start.
  const worded = weak.length
    ? `delulu — ${weak.length} decision(s) under ${namedBlocks(r.agentWorded.map((a) => a.section))} rest on words the agent wrote, not the user's:\n${weak.map((i) => `  \u2248 ${i}`).join('\n')}\n`
    : '';
  const note = soft.length ? `delulu, ${soft.length} decision quote(s) could not be checked:\n${soft.map((i) => `  \u2022 ${i}`).join('\n')}\n` : '';
  const forward = carried.length ? `delulu \u2014 ${carried.join('\n')}\n` : '';
  // Its own sentence, never folded into the shelves above. Those say "delulu looked and is unsure";
  // this says "delulu never looked", and lending it their wording would claim a check that did not
  // happen, the exact overclaim the rest of this file exists to unwrite.
  const unrun = unrecorded.length
    ? `delulu \u2014 this handoff was written by an earlier delulu, so part of the check could not run:\n${unrecorded.map((u) => `  \u25e6 ${u}`).join('\n')}\n`
    : '';
  return hard + worded + note + forward + unrun;
}

/**
 * Resolve `<stamp>:L<n>` against the handoff library on disk.
 *
 * Lives here, beside the parser and the check, because BOTH callers need it \u2014 `--restate` grades
 * the payload it has just sealed, `resume` grades it again at load \u2014 and a second copy of "how to
 * find an earlier session's record" is how two copies of one message in this codebase have already
 * drifted apart. Never throws: a session that was pruned, or captured on another machine, is an
 * UNKNOWN, and the check reports unknowns as unchecked rather than as invented.
 */
export function carriedLookup(base: string): CarriedLookup {
  return (session) => {
    // Re-validated at the filesystem boundary even though `refScan` already pinned the shape. The
    // session id comes out of agent-written prose, and a path built from unvalidated prose is how a
    // payload gets to name `../../somewhere-else`. Cheap, and it cannot false-negative: this is
    // exactly the set of names `handoff` creates folders with.
    if (!STAMP_ONLY.test(session)) return null;
    try { return parseCitationRecord(readFileSync(join(base, session, 'citations.json'), 'utf8')); }
    catch { return null; }
  };
}
