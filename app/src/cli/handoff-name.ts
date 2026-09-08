// delulu — the short, human name a handoff is known by.
//
// The folder stamp (`2026-08-20T03-48-19`) REMAINS the address: it is the directory on disk and it
// is what every stored citation resolves through. Nothing in this file moves it, so every ref that
// resolves today resolves byte-identically after this. What changes is what a HUMAN is shown.
//
// A stamp answers none of the questions anyone actually asks of a handoff — not "when was this",
// not "what was it about" — and it was the first thing in every list, every header and every
// carried citation. A user reading one could not tell what it referred to.
//
// The name lives in its OWN file rather than inside `citations.json`, deliberately. That record is
// rewritten by `--restate`, and `parseCitationRecord` drops every key it does not know — so a name
// stored there would be silently erased the first time a handoff was resealed, and the erasure
// would look exactly like a handoff that was never named.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Exactly the folder names `handoff` creates: a stamp, optionally `-2` on a same-second collision. */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A name is one line of prose, and it has to survive being embedded in a payload. */
const NAME_CAP = 48;

export interface StampWhen {
  /** Absolute and therefore SAFE TO STORE: `Aug 20`. A calendar date cannot become false. */
  day: string;
  /** Relative and therefore RENDER-ONLY: `6 days ago`. Storing this is how a record rots. */
  age: string;
}

/**
 * `2026-08-20T03-48-19` -> `{ day: 'Aug 20', age: '6 days ago' }`, or `null` if it is not a real date.
 *
 * Parsed as LOCAL wall-clock, because the folder name was built from local time. Reading it as UTC
 * renders the wrong DAY for anything captured in the evening — and a wrong date is strictly worse
 * than no date, because a missing one reads as missing while a wrong one reads as fact.
 *
 * Every component is checked to round-trip before it is trusted. `new Date(2026, 12, 45)` does not
 * throw and is not NaN — it ROLLS OVER into the following year. Without the round-trip check a
 * malformed stamp would render a confident, wrong day instead of degrading to silence.
 */
export function stampWhen(stamp: string, now: Date): StampWhen | null {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const when = new Date(y, mo - 1, d, h, mi, s);
  if (when.getFullYear() !== y || when.getMonth() !== mo - 1 || when.getDate() !== d) return null;

  // The year is shown ONLY when it is not the current one. Carrying "2026" on every line of a list
  // where every entry is 2026 is noise; dropping it from a handoff two years old is a lie.
  const day = `${MONTHS[mo - 1]} ${d}${y === now.getFullYear() ? '' : ` ${y}`}`;

  // Whole CALENDAR days apart, not elapsed hours: a handoff from 11pm last night is "yesterday" to
  // a human at 9am, and "0 days ago" to a subtraction.
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(when)) / 86_400_000);
  const age = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return { day, age };
}

/**
 * Strip a candidate name down to something that can sit inside a payload without breaking it.
 *
 * Double quotes are removed rather than escaped: the citation checker finds the PROOF on a DECIDED
 * line by looking for a quoted fragment, so a quote mark inside a name beside it could be read as
 * the start of the evidence. Newlines collapse for the same reason `decidedLines` fuses wrapped
 * lines — a name that wraps would be read as part of the decision.
 */
export function cleanName(raw: string): string | null {
  const one = raw.replace(/[\r\n]+/g, ' ').replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > NAME_CAP ? `${one.slice(0, NAME_CAP - 1).trimEnd()}…` : one;
}

/** The stored name for one handoff, or `null` when it has never been named. Never throws. */
export function readName(base: string, ts: string): string | null {
  try { return cleanName(readFileSync(join(base, ts, 'name.txt'), 'utf8')); } catch { return null; }
}

/** Name a handoff. Returns what was actually stored, or `null` if the candidate was unusable. */
export function writeName(base: string, ts: string, raw: string): string | null {
  const name = cleanName(raw);
  if (!name) return null;
  try { writeFileSync(join(base, ts, 'name.txt'), `${name}\n`, { mode: 0o600 }); } catch { return null; }
  return name;
}

/**
 * What to call this handoff in front of a human, best available first.
 *
 * The ladder degrades toward HONESTY, never toward prettiness: a real name, else the date it was
 * captured, else, only if the stamp is not even a parseable date, the stamp itself. The last rung
 * is deliberately the ugly one. An unreadable address the reader can still resolve beats a
 * beautiful label pointing at nothing.
 */
export function handoffLabel(base: string, ts: string, now: Date): string {
  const name = readName(base, ts);
  if (name) return name;
  const when = stampWhen(ts, now);
  return when ? `${when.day} handoff` : ts;
}

/** A citation carried from an earlier handoff: the folder stamp, then the line inside it. */
const CARRIED_REF = /`(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?):L(\d+)`/g;

/**
 * Show every carried citation by the NAME of the handoff it points at, for printing only.
 *
 * `2026-08-17T20-01-36:L92` -> `continuity is the product · L92`
 *
 * The file on disk is NOT touched, and that is the whole design. The stamp is what makes a carried
 * ref resolvable, `carriedLookup` reads `.delulu-handoff/<stamp>/citations.json` to re-check the
 * quote against the session that actually holds it, so rewriting the stored form would trade a
 * provable citation for a pretty one. This runs after the check has already passed over the stored
 * text, so what is verified and what is displayed are the same claim, addressed two ways.
 *
 * A ref whose handoff is gone, or whose stamp is not a real date, is LEFT EXACTLY AS IT IS. An
 * address the reader can still resolve beats a label pointing at nothing.
 */
export function nameCarriedRefs(text: string, base: string, now: Date): string {
  return text.replace(CARRIED_REF, (whole, stamp: string, line: string) => {
    const name = readName(base, stamp);
    if (name) return `\`${name} · L${line}\``;
    // No name. The stamp is only worth HIDING while the folder it addresses is still there to be
    // opened, once that handoff is gone the stamp is the last trace of which session this came
    // from, and a date would erase it while looking tidier. Unresolvable stays ugly on purpose.
    const when = existsSync(join(base, stamp)) ? stampWhen(stamp, now) : null;
    return when ? `\`${when.day} handoff · L${line}\`` : whole;
  });
}

/** The title line a payload was written under, which still carries the stamp of that moment. */
const TITLE = /^(# delulu handoff(?: —|:) .+?) · (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?)$/m;

/**
 * Show the payload's own title by name rather than by the stamp it was captured under.
 *
 * `# delulu handoff, delulu · 2026-08-20T03-48-19` -> `# delulu handoff, delulu · dead weight, live bugs`
 *
 * Print-time only, like `nameCarriedRefs`: the stored title is the record of when this was written
 * and is left exactly as it is. This is the FIRST line of the handoff, so it was the last place the
 * stamp still greeted the reader.
 */
export function nameTitle(text: string, base: string, now: Date): string {
  return text.replace(TITLE, (whole, head: string, stamp: string) => {
    const label = readName(base, stamp) ?? stampWhen(stamp, now)?.day;
    return label ? `${head} · ${label}` : whole;
  });
}
