// Is a payload sound enough to hand to the next session?
//
// Shared deliberately. `resume` and `pruneHandoffs` each had their OWN idea of "unfinished", and
// they disagreed: prune tested only for the literal `<!-- delulu:fill` marker, while resume also
// flagged empty section bodies. So a handoff resume called incomplete could be deleted by prune —
// and the prune message printed "unfinished handoffs are never pruned" in the same line that named
// the folder it had just removed. One definition, imported by both, is the only way that stays true.

/**
 * THE DELIVERY CLIFF — the second way a payload arrives with a hole in it.
 *
 * Everything above this line asks whether the payload is SOUND. This asks whether it can be
 * HANDED OVER, which turns out to be a separate question with its own silent failure.
 *
 * `commands/resume.md` delivers the whole payload through one Bash stdout, and Claude Code
 * replaces any Bash output above ~30,000 bytes with a 2KB preview plus a `<persisted-output>`
 * notice. Measured, not inferred: 26,000 bytes came through whole; 33.2KB came back as
 * "Output too large (33.2KB)... Preview (first 2KB)". The fresh session then receives the title
 * line, part of STATE, and nothing else — no THREAD, no DECIDED, no NEXT — while resume.md is
 * telling that same agent "treat the handoff as full context: the user must NOT have to
 * re-explain anything". `resume` exits 0. Nothing notices. That is the exact failure this
 * codebase exists to prevent, arriving through the pipe instead of through the file.
 *
 * It is not hypothetical either: this repo's own stored handoffs deliver at 26.8KB, 23.9KB and
 * 22.8KB — the largest is at 89% of the cliff, one long session away from crossing it.
 *
 * SAFE_DELIVERY_BYTES is deliberately NOT set just under the 30,000 the harness documents. It is
 * set under the largest size a human has actually watched arrive intact (26,000), because the
 * cliff is the harness's number, not ours: it moves with a release, and `BASH_MAX_OUTPUT_LENGTH`
 * lets any user move it down today. A budget justified by a measurement survives both.
 *
 * The cost of being wrong is asymmetric, and that is the whole argument for the headroom: too low
 * costs the reader one `Read` of a file whose path is printed at the top; too high costs them the
 * handoff, silently, with no way to tell it happened.
 */
export const BASH_OUTPUT_CLIFF = 30_000;
/**
 * 25,000 -> 27,000, on a measurement taken rather than a figure remembered.
 *
 * The old 25,000 was justified above by "the largest size a human has actually watched arrive
 * intact (26,000)". That sentence was true and it was not a boundary — 26,000 was simply the
 * largest payload anyone had happened to send. Nobody had gone looking for where the edge is, so a
 * budget was being derived from the high-water mark of ordinary use.
 *
 * The edge was then probed directly, on 2026-08-29, with `BASH_MAX_OUTPUT_LENGTH` unset:
 *   - 29,500 bytes arrived WHOLE — a marker written as the final bytes of stdout was present;
 *   - 31,000 bytes came back as `Output too large (30.3KB)` plus a 2KB preview.
 * So the cliff sits at 30,000 exactly, where the harness documents it, and 29,500 is now the
 * largest delivery observed to survive.
 *
 * 27,000 sits 2,500 under what was measured to work and 3,000 under the cliff itself, and it is
 * what lets the share table below give every block the room its own history asks for instead of
 * cutting the user's own words to pay for the rest.
 *
 * The asymmetry that set the original margin has NOT changed and still argues against going
 * further: too low costs the reader one `Read` of a file whose path is printed at the top; too high
 * costs them the handoff. The cliff is still the harness's number, it can still move with a
 * release, and any user can still lower it — which is why this stops well short of it rather than
 * spending the headroom the measurement revealed.
 */
export const SAFE_DELIVERY_BYTES = 27_000;

/**
 * What `resume` prints around the payload — the loading line, the moved-since / provenance blocks,
 * the reading instructions — is part of the same output and spends the same budget.
 *
 * MEASURED, not remembered. Across all eight handoffs in this repo the preamble runs 1,779 to
 * 3,358 bytes, median ~2,310. The previous value here was 2,000, described as "~1.5KB with room",
 * and SIX of the eight exceed it. The largest is the newest, which is the shape of the problem
 * rather than an outlier: the preamble grows with carried rules and flagged decisions, the two
 * things delulu exists to accumulate.
 *
 * This is NOT what the delivery path fits against — that measures the real preamble it is about to
 * print (`fixed` in resume.ts) and was never wrong. This number drives `shareReport` at CAPTURE
 * time, so under-reserving here makes the seal-time warning too permissive: a payload that passes
 * the check at 24,900 bytes still arrives trimmed, because 24,900 + a 3,358-byte preamble is over
 * the delivery budget. Silence at capture followed by a trim on arrival is the exact experience
 * this warning exists to prevent.
 *
 * 3,600 covers the worst observed with a little room. Each of the six provenance lists is capped at
 * `LIST_CAP`, so the variable part is bounded rather than open-ended — but it is bounded well above
 * the median, which is why this sits near the top of the observed range and not at it.
 */
export const PREAMBLE_RESERVE = 3_600;

export const SAFE_PAYLOAD_BYTES = SAFE_DELIVERY_BYTES - PREAMBLE_RESERVE;

/**
 * Which blocks `resume` may leave out when the payload cannot fit, LEAST critical first — and by
 * being a list rather than a rule, what it may never leave out: STATE, THREAD, NEXT, the fence,
 * and any heading delulu did not write are absent here and are therefore undroppable.
 *
 * Ordered by how much of the handoff dies with the block:
 *   1. `Full context`     — recoverable in full from `payload.md`, whose path the notice prints.
 *                           NOT empty: it carries up to 12 subagent gists (2,624 bytes on the one
 *                           stored handoff that trims), and the notice names only `payload.md`,
 *                           never `index.md` or `context.md`. It goes first because it is the only
 *                           block whose whole content is recoverable from a path, not because it
 *                           is worthless.
 *   2. `THE AGENT'S READ` — the payload's own heading says NOT proven; the reader is told to
 *                           re-check every line of it before acting anyway.
 *   3. `WHAT ELSE FAILED` — the agent's account of history. Explains the past, not the next move.
 *   4. `WHAT FAILED`      — engine-extracted tool errors. Same: history, and the highest-volume
 *                           block after IN YOUR WORDS.
 *   5. `DECIDED`          — the user's rulings. Genuinely painful, so it goes late; any line that
 *                           failed its citation check is quoted in resume's provenance block,
 *                           which is computed at load and survives the trim.
 *   6. `IN YOUR WORDS`    — the user's own voice, engine-proven, and usually the largest block in
 *                           the file. Last, because a resume without it is a briefing rather than
 *                           a continuation — but a named absence still beats a silent one.
 * Shared so `handoff` can warn in the same terms `resume` will act in; two lists would drift, and
 * a warning that names blocks resume does not actually drop is its own small lie.
 */
/**
 * Every section a handoff carries, named ONCE, here.
 *
 * These used to be shouted labels — `## STATE`, `## IN YOUR WORDS`, `## THE AGENT'S READ` — that a
 * reader had to decode before they could read anything. They are plain sentences now.
 *
 * The words are load-bearing, which is why they live in one place instead of being spelled out at
 * each site. Several things match a section by its exact heading — the count is deliberately not
 * given here, because it has been wrong before — and every one of them fails SILENTLY when it stops
 * matching: the citation checker finds no decisions and reports a clean bill
 * over an unchecked block, and the delivery trimmer recognises nothing as droppable, so an oversized
 * handoff stops being trimmed and is cut by the pipe instead. Neither raises an error. Renaming a
 * heading in the template while a matcher still spells the old one is therefore not a typo, it is a
 * quiet loss of the check — so no matcher and no emitter may spell a heading itself.
 *
 * Where a comment in this codebase says DECIDED it means the user's rulings as a whole. They are
 * two blocks now, `holds` and `decided`, and a comment that means only one of them names it.
 */
export const SECTION = {
  /** Engine-written: read from real git and disk at capture. */
  state: 'What I checked myself',
  /** Engine-written: the user's own messages, verbatim. */
  said: 'What you said',
  /** Engine-written: tool errors, extracted from the transcript. */
  broke: 'What broke',
  /**
   * Agent-written, cited like `decided` — and the ONLY block that outlives the session that wrote
   * it. Its name carries its own caveat, exactly as `read`'s parenthetical does, and for the same
   * reason: this block's sharpest failure is a rule that stopped being true still arriving with a
   * verbatim citation attached, which reads as MORE authoritative than a fresh judgement precisely
   * because it has provenance. "until you say otherwise" is the mitigation — it tells the reader,
   * every time they read it, that the only thing keeping this line here is that nobody revoked it.
   */
  holds: 'What holds until you say otherwise',
  /** Agent-written: the live conversation, where it stopped. */
  thread: 'Where we left off',
  /** Agent-written: the failures no tool recorded. */
  elseWrong: 'What else went wrong',
  /**
   * Agent-written, every line cites where the user said it — and it DIES at the session boundary,
   * which is what "this session" in the name is for.
   *
   * It used to be called `What you decided` and it held both lifetimes at once: a permanent rule and
   * a one-session task directive, in one block, emptied every session. Measured on this repo's own
   * library, decisions that crossed a session boundary ran 0, 0, 0, 0, then 4 of 18 once the engine
   * carried them. "Continuity is the product" was locked on 2026-08-17, appeared in NO later
   * handoff, and was restated across five sessions in thirteen days.
   */
  decided: 'What you decided this session',
  /** Agent-written and NOT checked. The parenthetical is the trust boundary, not decoration. */
  read: 'What I made of it (unchecked)',
  /** Agent-written: the one thing to do first. */
  next: 'Start here',
  /** Pointers to the deep files. */
  more: 'More, if you need it',
  /** Only in context.md. */
  subagents: 'What the subagents found',
} as const;

/** The line that closes a payload. Matched when splitting, so it is named here with the rest. */
export const CLOSER = `Pick it up from **${SECTION.next}**`;

/**
 * What gets dropped first when a handoff is too big to survive the pipe, least costly first.
 *
 * Read as a sentence: lose the agent's unproven read first, then what else went wrong, then the
 * errors, then the decisions — and lose the user's own words before the pointers, which are last
 * because they are how the reader reaches everything that was dropped.
 */
/**
 * `SECTION.holds` IS NOT HERE, AND THAT IS THE FEATURE.
 *
 * Anything absent from this list is undroppable — that is how STATE, THREAD and NEXT are already
 * protected, and it is said first because a rule the size guard can silently delete is not a rule.
 * The block is small; losing it costs the one thing the reader is meant to read before the rest.
 */
export const DELIVERY_DROP_ORDER: readonly string[] = [
  SECTION.read,
  SECTION.elseWrong,
  SECTION.broke,
  SECTION.decided,
  SECTION.said,
  SECTION.more,
];

/**
 * WHY `more` MOVED FROM FIRST TO LAST, having been the cheapest loss since this list existed.
 *
 * It was ranked first on the reasoning that a block recoverable from a path costs nothing to lose.
 * That reasoning inverts itself once you measure what it points AT. On the handoff that prompted
 * this change, `context.md` was 122,115 bytes and `index.md` 10,192 — 132KB of subagent findings
 * and the line-map into the raw transcript. The payload is a ~7,000-token POINTER into that, and
 * `more` is the pointer. Dropping it first spends the map to save 2,911 bytes while the block
 * holding the user's messages keeps 10,200.
 *
 * It dropped, in the field, on 2026-08-29, and the session that inherited that payload got the
 * blocks that name the deep files only because it went looking for them by hand.
 *
 * So it goes last, and its share below is small enough that the trim should never reach it: once
 * `more` carries pointers instead of a copy of the gists already in `context.md`, it is a few
 * hundred bytes whose loss costs access to everything delulu wrote down.
 */

/**
 * What each block may spend of `SAFE_PAYLOAD_BYTES`, and the only thing standing between one block
 * and the whole budget.
 *
 * WHY THIS EXISTS. `DELIVERY_DROP_ORDER` decides what to lose once a payload is already too big.
 * Nothing decided how it got too big. Re-measured 2026-09-07 over the eight completed handoffs in
 * this repo with `shareReport` itself: median payload 23,311 bytes against the 23,400 budget, and
 * three of the eight carry at least one block past its share. Trimming is not the exceptional case
 * this codebase once treated it as.
 *
 * (An earlier version of this comment claimed a ~29,000-byte median. It was never re-checked as the
 * library grew and it was wrong by six kilobytes. The numbers here are dated for that reason: a
 * measurement with no date is a claim waiting to rot, in a file whose whole argument is that an
 * unchecked note is worse than no note.)
 *
 * Two specific findings the numbers below answer:
 *   - `What you said` has a de-facto ceiling around 10,200 bytes; the two largest handoffs land at
 *     10,192 and 10,199. That is 44% of the whole budget going to one block by an accident of where
 *     its elision was tuned, not by anyone deciding it should.
 *   - The rules split roughly DOUBLED what rulings cost. The old combined block ran a 2,692-byte
 *     median; `holds` + `decided` now run 5,020 on the handoff that prompted this. The feature was
 *     right and its cost was never subtracted from the budget it spends.
 *
 * CEILINGS, NOT RESERVATIONS. A block under its share does not hold the remainder — the unspent
 * bytes are available to blocks that want more. A session with two standing rules must not waste
 * 3,600 bytes on nothing, and a session with a long thread should be able to use them.
 *
 * WHERE IT BINDS: at CAPTURE, not at delivery. `holds` is deliberately absent from the drop order
 * because a rule a size guard can silently delete is not a rule — and truncating it at LOAD would
 * be the same deletion wearing a share's clothing, with the added insult that the session
 * inheriting the rule would never learn it existed. At capture the user is present, in an
 * interview, and can retire a spent rule or promote one into code. Byte pressure becomes the
 * routing conversation at the one moment there is somebody there to have it.
 *
 * The values sum to exactly `SAFE_PAYLOAD_BYTES`; a test asserts it, because a table that quietly
 * sums to more than the budget is a budget that does not exist.
 */
export const BLOCK_SHARES: Readonly<Record<string, number>> = {
  // WHERE THE PREAMBLE RESERVE WAS PAID FROM. Correcting the reserve from a remembered 2,000 to a
  // measured 3,600 took 1,600 bytes out of this table, and it matters which blocks paid.
  //
  // The three ENGINE blocks did not. `said`, `broke` and `state` carry facts, and facts do not
  // compress: `said` guarantees every message is carried by SHORTENING rather than deleting, and
  // cutting its share to 6,400 was tried and broke exactly that — a long session lost nine messages
  // outright instead of quoting all sixty more briefly. A budget that silences the user to pay for
  // the sentence describing the budget has the priority backwards.
  //
  // So the six AGENT-written prose blocks absorbed it, roughly in proportion, because prose is the
  // thing that can say the same amount in less. `holds` is exempt among them: a test pins it above
  // 3,396, and shrinking the standing-rules block to pay for a preamble is the trade this module
  // exists to refuse.
  [SECTION.said]: 8_000,
  [SECTION.holds]: 3_600,
  [SECTION.broke]: 2_000,
  [SECTION.read]: 1_900,
  [SECTION.thread]: 1_800,
  [SECTION.decided]: 1_700,
  [SECTION.next]: 1_450,
  [SECTION.elseWrong]: 1_250,
  [SECTION.state]: 1_100,
  // Held at 600 rather than cut with the rest of the prose. Since the pointers were costed FIRST,
  // context.md and index.md are costed FIRST and in full, and the subagent gists take whatever is
  // left — so this share is not a ceiling on prose, it is the room the gists live in. Trimmed to
  // 500 the pointers consumed all of it and every gist disappeared, which is a block silently
  // losing its content rather than shortening it. The extra 100 came from `read` instead, the most
  // compressible thing in the file: the agent's own unchecked conclusions.
  [SECTION.more]: 600,
};

/** One block that has outgrown its share, with both numbers so a message can name them. */
export interface ShareOverrun { name: string; bytes: number; share: number }

/**
 * Every block spending more than its share, biggest overrun first.
 *
 * Reports and does not cut. The caller is `handoff`, at seal time, and what it does with this is
 * TELL somebody — never trim on its own. A block silently shortened to fit a table is the failure
 * this whole module exists to prevent, arriving through the fix for it.
 *
 * Counted as the heading plus its body, because that is what the pipe counts. Blocks a sealed
 * handoff still carries under an older name are found through `headingsFor` and reported against
 * the share of the block they ARE — otherwise every pre-split handoff would look compliant by
 * virtue of being unrecognised.
 */
export function overShare(payload: string): ShareOverrun[] {
  const canonical = new Map<string, string>();
  for (const name of Object.keys(BLOCK_SHARES))
    for (const alias of headingsFor(name)) canonical.set(alias, name);
  const out: ShareOverrun[] = [];
  for (const { name, head, body } of sectionBodies(payload, [...canonical.keys()])) {
    const key = canonical.get(name);
    if (key === undefined) continue;
    const bytes = deliveryBytes(head + body);
    const share = BLOCK_SHARES[key];
    if (bytes > share) out.push({ name: key, bytes, share });
  }
  return out.sort((a, b) => (b.bytes - b.share) - (a.bytes - a.share));
}

/**
 * The smallest overrun worth a sentence. Below this a "finding" is rounding, and a checker that
 * reports rounding is one the reader learns to click past — which is how the real overruns get
 * missed too. Only ever a TAIL guard; it never decides whether to report at all.
 */
export const SHARE_NOISE_FLOOR = 150;

/**
 * The blocks worth naming when a payload will not fit — and NOTHING when it will.
 *
 * WHY A BLOCK OVER ITS SHARE IS USUALLY NOT A PROBLEM. The shares are ceilings, not reservations:
 * unspent bytes belong to whichever block needs them. So a block above its share in a payload that
 * still FITS has borrowed room nobody wanted, which is the table working. Reporting it would be
 * reporting a non-event — and measurably so: `2026-08-17T20-01-36` fits at 22,150 bytes while
 * carrying blocks above their shares, every one of them a false alarm.
 *
 * WHAT IS WORTH SAYING, when the payload is genuinely over: every block meaningfully past its
 * share, worst first. Measured 2026-09-07, five of this repo's eight completed handoffs fit and
 * three do not; the three that do not report four to five blocks each, not the whole list the naive
 * version produces, because the floor takes the rounding.
 *
 * IT DELIBERATELY DOES NOT STOP AT COVERAGE. The first version of this named only the fewest
 * blocks whose overrun added up to the excess, which is shorter and was wrong: on the failing
 * handoffs where `What you said` is the largest overrun it alone covered the excess, so the report
 * named the block we least want cut and stayed silent about `More, if you need it` at 2,815 bytes
 * against 600 — the clearest waste in the
 * file, duplicating gists that are already in `context.md`, and the block whose bloat prompted this
 * work. A report that hides the easy fix behind the painful one is worse than a slightly longer
 * report.
 *
 * WHY NOT A PLAIN BYTE FLOOR INSTEAD. A fixed floor answers "is this block over by enough to
 * mention", which sounds like the same question and is not. It is blind to exactly the failure this
 * codebase cares about: a block creeping a hundred bytes a session never trips a floor, and ten
 * sessions later it has taken a thousand. Covering the excess has no such blind spot — growth
 * surfaces the moment it costs something, at whatever size it happens to be.
 */
export function shareReport(payload: string): ShareOverrun[] {
  if (deliveryBytes(payload) <= SAFE_PAYLOAD_BYTES) return [];
  return overShare(payload).filter((o) => o.bytes - o.share >= SHARE_NOISE_FLOOR);
}

/** Size as the harness counts it — BYTES, not characters. The payload is full of `—`, `·` and
 *  `≈`, each of which is one character and two or three bytes, so counting characters under-reports a
 *  real payload by hundreds of bytes in the one direction that loses data. */
export function deliveryBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Where the engine-written zone ends and the agent-written sections begin. */
export const AGENT_ZONE = '\n---\n> **Everything below';

/**
 * Where a section's body stops: the next heading, or a real fence.
 *
 * `esc` is applied because both fences contain regex metacharacters (`*`, `[`), and spelling them
 * out by hand is how the matcher drifts away from the text it is supposed to track.
 */
const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECTION_END = new RegExp(`\\n##\\s|${esc(AGENT_ZONE)}|\\n---\\n${esc(CLOSER.slice(0, 20))}`);

/**
 * A regex matching one section's heading line, built FROM its name so it cannot drift from it.
 *
 * The name is escaped before it becomes a pattern: `What I made of it (unchecked)` carries brackets
 * that a raw interpolation would read as a capture group, and the heading would then never match
 * the text it was built from.
 */
export function headingRe(name: string): RegExp {
  return new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*$`, 'm');
}

/**
 * A heading a SEALED handoff may still carry under an OLDER name.
 *
 * A handoff seals the moment a newer one exists and is never written to again, so an old heading
 * stays readable forever. Measured 2026-09-07: of the eight completed handoffs stored here, three
 * say `## What you decided this session` and the rest carry earlier spellings, the oldest none of
 * them at all. Whatever a stored handoff said, it still says. The matchers that key off
 * these names fail SILENTLY when one stops matching — the citation checker would report a clean
 * bill over an unchecked block, and the delivery trimmer would stop recognising the block as
 * droppable. So the old name is not deleted when a section is renamed; it is recorded here, ONCE,
 * and every matcher asks this instead of spelling a name itself.
 */
export const DECIDED_BEFORE_SPLIT = 'What you decided';
export const ALSO_KNOWN_AS: Readonly<Record<string, readonly string[]>> = {
  [SECTION.decided]: [DECIDED_BEFORE_SPLIT],
};

/** Every heading that names this section in some handoff on disk — current name FIRST. */
export function headingsFor(name: string): readonly string[] {
  return [name, ...(ALSO_KNOWN_AS[name] ?? [])];
}

/**
 * The blocks whose lines are the USER's rulings, and are therefore graded against what they said.
 *
 * Both of them, in the order they appear in the file. The split is the whole point: `holds` is
 * carried until it is revoked, `decided` is spent at the session boundary — but the CHECK does not
 * care which lifetime a ruling has. A fabricated citation is a fabricated citation in either block,
 * and a permanent rule resting on words the user never said is the worse of the two.
 */
export const RULING_SECTIONS: readonly string[] = [SECTION.holds, ...headingsFor(SECTION.decided)];

/**
 * The body under every heading in `names`, in FILE order, tagged with the name that claimed it.
 *
 * ONE walk over the headings, not one search per name, because the names now OVERLAP: the sealed
 * `What you decided` is a prefix of the current `What you decided this session`, and `headingRe`
 * deliberately allows a trailing gloss (`## What you said — every message you sent…`), so a
 * per-name search would find the SAME physical heading twice and grade its decisions twice —
 * doubling every citation finding on every new handoff. Each heading is claimed once, by the
 * LONGEST name that matches it.
 *
 * The name returned is the one written IN THE FILE (see `ALSO_KNOWN_AS`), which is what lets every
 * "N line(s) under X" message describe a payload by a heading it actually carries.
 */
export function sectionBodies(payload: string, names: readonly string[]): { name: string; head: string; body: string }[] {
  const byLongest = [...names].sort((a, b) => b.length - a.length);
  const out: { name: string; head: string; body: string }[] = [];
  for (const m of payload.matchAll(/^##\s+[^\n]*$/gm)) {
    if (m.index === undefined) continue;
    const name = byLongest.find((n) => headingRe(n).test(m[0]));
    if (name === undefined) continue;
    // Same bound the DECIDED reader has always used: the next heading, or the rule that opens the
    // closer — whichever comes first.
    const rest = payload.slice(m.index + m[0].length);
    // A `---` ends a section only when it is one of the payload's two STRUCTURAL fences: the line
    // that opens the agent zone, and the one before the closer. Matching a bare `\n---\n` meant any
    // horizontal rule written inside a ruling block ended that block early — while every line below
    // the rule still shipped under the heading, still read as a locked decision, and was never
    // checked again. One line of markdown switched the guarantee off for everything after it.
    //
    // Built from AGENT_ZONE and CLOSER rather than spelled out, so a reworded fence cannot silently
    // stop being recognised and take the section boundary with it.
    const end = rest.search(SECTION_END);
    out.push({ name, head: m[0], body: end === -1 ? rest : rest.slice(0, end) });
  }
  return out;
}

/**
 * WHICH BLOCK A RULING BELONGS IN — delulu's guess, which the user then corrects.
 *
 * Unaided agent judgement is what this codebase has already watched fail at the neighbouring job:
 * given nothing but its own memory of the session, it carried 0 constraints across each of four
 * boundaries. So the guess here is made from signals that can be read off the line and argued with
 * rather than from a model's opinion, and it is never acted on silently — every caller PRE-SORTS
 * and SHOWS the sort, and `unsorted` exists so that "delulu has no signal" is not dressed up as an
 * answer.
 *
 * The signals, strongest first:
 *   1. It came from the previous handoff's RULES block. Already sorted, by a human, and nothing
 *      ages out on its own — only an explicit revocation removes it.
 *   2. It already carries a SESSION-QUALIFIED ref. That line has survived a session boundary
 *      intact; durability is not a guess about it any more, it is a fact about it. This is also
 *      what seeds the split without touching a sealed handoff: the four decisions carried into
 *      `2026-08-27T17-38-01` are exactly the lines with a `<stamp>:L<n>` ref, and they arrive in
 *      the rules block still wearing the ref of the session that holds their words.
 *   3. It READS as a rule — "always", "never", "must", "from now on". A standing instruction is
 *      written differently from a task, and it is written that way by the user, not by us.
 *   4. It names a specific FILE, PATH or COMMIT. "Delete `~/.delulu` outright" is done the moment
 *      it is done; carrying it forward for ever is how a spent directive becomes furniture.
 *
 * 3 beats 4 deliberately: "never edit `payload.ts` by hand" names a file AND is a standing rule,
 * and it is the rule that matters. Anything matching nothing is `unsorted`, which is the ONLY
 * outcome that changes no behaviour at all — an unsorted line is carried and offered exactly as
 * every carried line was before this split existed, so the feature cannot regress a handoff.
 */
/**
 * WHY A RULE IS STILL A RULE — the marker a carried line must wear to keep its place.
 *
 * `- Never ship on a Friday. `L12`: "not on a friday" — cannot be a check: nothing in the repo
 * knows what day it is`
 *
 * The rules block reached 29 lines and became junk, and the reason was that carrying was the
 * DEFAULT: a line got in by reading like it endured, and nothing ever asked the only question that
 * matters. Ten of those 29 were already enforced by a test or by `handoff.md` — the user was being
 * told, every session, about behaviour delulu could not get wrong. Four were one sentence repeated
 * across three sessions. The rest were direction given in the moment, spent on arrival.
 *
 * So the default is inverted. A constraint that a check could hold belongs in the check, where it
 * is enforced instead of described and costs nothing to read. A line only stays here when it
 * genuinely cannot be one — a judgement about risk, a preference about taste — and then it has to
 * say why, in the open, where the next session can disagree with the reason rather than inherit it.
 */
const CANNOT_BE_A_CHECK = /—\s*cannot be a check:\s*(\S.*?)\s*$/;

/** The stated reason this line cannot be enforced by a check, or undefined if it makes no claim. */
export function carryReason(line: string): string | undefined {
  return CANNOT_BE_A_CHECK.exec(line)?.[1];
}

/** The phrase a line must carry to keep its place in the rules block. Named so prompts stay in step. */
export const CARRY_REASON_MARKER = 'cannot be a check:';

export type Lifetime = 'rules' | 'session' | 'unsorted';

/** Reads as a standing instruction rather than as a task. */
const RULE_SHAPE = /\b(?:always|never|must|mustn't|do not|don't|no longer|from now on|every time|by default|under no circumstances|only ever)\b/i;

/**
 * Names one concrete thing — a path, a filename, or a commit.
 *
 * BACKTICKED spans only. delulu's own template writes paths and commits in backticks, and an
 * unquoted test would have to decide whether a dotted or hex-looking token loose in prose is a
 * filename — the kind of judgement that, elsewhere in this codebase, has accused honest lines every
 * time it has been attempted. The citation refs this runs over cannot collide with it: `L412` has
 * no dot or slash, and `2026-08-17T20-01-36:L92` has neither either.
 */
const NAMES_A_THING = /`[^`\n]*[/.][^`\n]*`|`[0-9a-f]{7,40}`/;

/** A ref that already names its session — proof the line has survived at least one hop. */
const SURVIVED_A_HOP = /`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?:L\d+`/;

export function classifyRuling(line: string, from?: string): Lifetime {
  if (from !== undefined && headingRe(SECTION.holds).test(`## ${from}`)) return 'rules';
  // Signal 2 is muted for a line the user FILED AS SPENT, and this is the whole reason the section
  // is passed in rather than only consulted for the block above.
  //
  // "It survived a session boundary" was read as durability. For a line under the rules block that
  // is true. For one under DECIDED it is not: it records that the previous agent carried the line
  // and the user filed it as finished, and the stamp is the carrying, not the enduring. Without
  // this, one hop is enough to launder a spent directive into a standing rule and offer it back
  // under STILL HOLDS — measured on a real capture: `- Ship the stage-2 tree today, then stop.` was
  // filed under DECIDED, carried once, and came back offered as a rule that still holds. The user's
  // own sort is stronger evidence than a guess read off the words, and this was overruling it.
  //
  // Muted, not inverted. Signals 3 and 4 still run, so a decided line that genuinely READS like a
  // standing rule ("never edit `payload.ts` by hand") is still surfaced as one — which is the case
  // the promotion existed for. A line with no such wording falls to `unsorted`, where delulu asks
  // instead of asserting, and that is the honest answer for it.
  const filedAsSpent = from !== undefined
    && headingsFor(SECTION.decided).some((h) => headingRe(h).test(`## ${from}`));
  if (!filedAsSpent && SURVIVED_A_HOP.test(line)) return 'rules';
  if (RULE_SHAPE.test(line)) return 'rules';
  if (NAMES_A_THING.test(line)) return 'session';
  return 'unsorted';
}

/**
 * The ruling blocks this payload actually carries LINES in, named as IT names them, in file order.
 *
 * Empty bodies are left out. An empty rules block is legal (see `payloadProblem`), and pointing a
 * fresh session at a heading with nothing under it spends its attention on nothing.
 */
export function rulingHeadings(payload: string): string[] {
  return sectionBodies(payload, RULING_SECTIONS).filter((s) => s.body.trim()).map((s) => s.name);
}

/**
 * What to CALL this payload's rulings in a sentence about it — never empty, so the sentence works.
 *
 * Three steps down, each one a weaker claim than the last:
 *   1. the blocks that actually carry lines — what a reader will find if they go looking;
 *   2. failing that, the blocks that are THERE but empty — still true of the file in front of them;
 *   3. failing that, the name every payload used before the split. This is not hypothetical: the
 *      oldest handoff stored in this repo heads its rulings `## Key Decisions — settled, do NOT
 *      re-litigate`, which no matcher here recognises, so the sentence is inert on it either way —
 *      and naming it by a heading invented long after it was sealed would be inert AND wrong.
 */
export function rulingBlockNames(payload: string): string[] {
  const filled = rulingHeadings(payload);
  if (filled.length) return filled;
  const present = sectionBodies(payload, RULING_SECTIONS).map((b) => b.name);
  return present.length ? present : [DECIDED_BEFORE_SPLIT];
}

/**
 * `"A"`, or `"A" and "B"` — block names, quoted, in FILE order.
 *
 * ONE definition, imported by the checker and by the loader, because two copies of a message in
 * this codebase have already drifted apart and deleted a handoff between them.
 *
 * Sorted into file order rather than the order the caller collected them in — findings arrive on
 * three separate shelves, and concatenating those shelves can name the second block before the
 * first and describe a payload in an order it does not have.
 */
export function namedBlocks(names: readonly string[]): string {
  const order = (n: string) => { const i = RULING_SECTIONS.indexOf(n); return i === -1 ? RULING_SECTIONS.length : i; };
  const named = names.length ? [...new Set(names)].sort((a, b) => order(a) - order(b)) : [SECTION.decided];
  return named.map((n) => `"${n}"`).join(' and ');
}

/** The heading the engine always writes first. Its absence means the file is truncated or not ours. */
const STATE_HEADING = `## ${SECTION.state}`;

/**
 * A payload is incomplete when the agent never finished it, OR when the file itself is damaged.
 *
 * The damage half was missing and it mattered: `''.split(/^##\s.*$/m).slice(1)` is `[]`, so
 * `.some()` was false and a ZERO-BYTE payload was judged COMPLETE — then loaded as the newest
 * handoff, silently shadowing the good one beside it. A payload truncated after the STATE block
 * passed for the same reason. Both are reachable: a crash or a full disk between writing STATE and
 * writing the rest leaves exactly that file.
 *
 * Only the AGENT zone is scanned for empty sections. The engine-written blocks above the fence are
 * never blank by construction, and flagging them would put a false "incomplete" on a sound handoff.
 */
export function isIncompletePayload(text: string): boolean {
  // Asks the one below rather than restating its five conditions. They WERE two copies of the same
  // ladder — same guards, same order, same zone slice — inside the file whose header explains that
  // two copies of this exact predicate drifted apart and deleted a handoff. Two copies is how that
  // happens; the header was describing this file's own future.
  return payloadProblem(text) !== '';
}

/**
 * What is wrong with it, in words — so resume can SHOW the problem instead of loading in silence.
 * Empty string when the payload is sound.
 */
export function payloadProblem(text: string): string {
  if (!text.trim()) return 'the payload file is empty';
  if (!text.includes(STATE_HEADING)) return 'this file is missing the block delulu always writes first, so it is either cut short or not a delulu handoff';
  if (!text.includes(AGENT_ZONE)) return 'the payload stops before the agent-written sections — it looks truncated';
  if (text.includes('<!-- delulu:fill')) return 'some sections were never filled in';
  // A cut AFTER the fence was invisible. The two checks above catch a payload that stops before the
  // agent zone, and the blank-section count catches headings that were written and never filled —
  // but a file whose last sections are simply GONE has no blank heading to count and no missing
  // marker above, so it loaded clean. The closer is the reliable signal: it is the last line every
  // payload ends with, present on all seven stored here including the two whose interview never
  // happened, so it separates "cut short" from "unfinished" rather than conflating them.
  if (!text.includes(CLOSER)) return 'the payload has no closing line, so it is cut short — the sections after the cut are missing, not empty';
  // The closing line is cut off BEFORE the blank count, and that is not cosmetic. It always sits
  // under the final heading, so with it attached the last section always has content and an emptied
  // one could never be counted blank — the check silently could not fire on the single most
  // important section in the payload, which is the last one.
  const withCloser = text.slice(text.indexOf(AGENT_ZONE));
  // Anchored on the CLOSER itself, not on the rule above it: the agent zone OPENS with a `---`
  // fence, so cutting at the first horizontal rule deletes the whole zone and every section reads
  // as absent rather than blank.
  const closerAt = withCloser.lastIndexOf(CLOSER);
  const zone = closerAt === -1 ? withCloser : withCloser.slice(0, closerAt).replace(/\n---\n$/, '\n');
  // Headings are KEPT (a capture group; this used to discard them) because the two RULING blocks may
  // legitimately be empty and no other section may.
  //
  // The exemption is load-bearing, not cosmetic. `isIncompletePayload` is `payloadProblem(...) !==
  // ''`, so it governs prune and carry-forward as well as the warning. A session that locked no
  // standing rules, or no one-off directives, is a real session — and calling its handoff damaged
  // would make the NEXT capture walk straight past it when it looks for constraints to carry,
  // silently breaking the chain the split exists to protect. Not a hole: a block the agent never
  // filled still carries `<!-- delulu:fill`, caught above, so only a deliberately emptied one
  // passes here.
  const parts = zone.split(/^(##\s[^\n]*)$/m);
  let blanks = 0;
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i + 1]?.trim()) continue;
    if (RULING_SECTIONS.some((n) => headingRe(n).test(parts[i]))) continue;
    blanks++;
  }
  return blanks ? `${blanks} section(s) were left blank` : '';
}
