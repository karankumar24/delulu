// delulu — tests for the human name a handoff is known by.
//
// Every rule here exists because the alternative is a CONFIDENTLY WRONG label. A rolled-over date,
// a day shifted by a timezone, a name that swallows the citation beside it — each of those reads as
// fact to whoever opens the handoff next, which is worse than the unreadable stamp they replace.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampWhen, cleanName, readName, writeName, handoffLabel, nameCarriedRefs, nameTitle } from './handoff-name';

const NOW = new Date(2026, 7, 26, 12, 0, 0); // Aug 26 2026, local

const base = () => mkdtempSync(join(tmpdir(), 'delulu-name-'));
const folder = (b: string, ts: string) => { mkdirSync(join(b, ts), { recursive: true }); return ts; };

describe('stampWhen', () => {
  it('reads a real stamp as a local calendar day', () => {
    expect(stampWhen('2026-08-20T03-48-19', NOW)).toEqual({ day: 'Aug 20', age: '6 days ago' });
  });

  it('does NOT shift the day for a late-evening capture', () => {
    // Parsed as UTC from a machine behind UTC, `23-30` rolls into the NEXT day. The handoff would
    // then be labelled Aug 18 while its own folder says the 17th.
    expect(stampWhen('2026-08-17T23-30-00', NOW)?.day).toBe('Aug 17');
  });

  it('degrades to silence on an impossible date instead of rolling it over', () => {
    // `new Date(2026, 12, 45)` is neither an error nor NaN — it is Feb 14 2027. Without the
    // round-trip check this renders a confident, wrong day.
    expect(stampWhen('2026-13-45T00-00-00', NOW)).toBeNull();
  });

  it('accepts the same-second collision suffix the folder namer can produce', () => {
    expect(stampWhen('2026-08-20T03-48-19-2', NOW)?.day).toBe('Aug 20');
  });

  it('returns null for anything that is not a stamp', () => {
    for (const bad of ['', 'latest', 'context.md', '2026-08-20', '2026-08-20T03-48'])
      expect(stampWhen(bad, NOW)).toBeNull();
  });

  it('says today and yesterday rather than counting to zero', () => {
    expect(stampWhen('2026-08-26T01-00-00', NOW)?.age).toBe('today');
    // 11pm last night is YESTERDAY to a reader at noon, and 13 hours to a subtraction.
    expect(stampWhen('2026-08-25T23-00-00', NOW)?.age).toBe('yesterday');
  });

  it('shows the year only when it is not the current one', () => {
    expect(stampWhen('2026-06-18T19-53-37', NOW)?.day).toBe('Jun 18');
    expect(stampWhen('2025-06-18T19-53-37', NOW)?.day).toBe('Jun 18 2025');
  });
});

describe('cleanName', () => {
  it('strips quotes and backticks that could be read as the citation beside it', () => {
    // A DECIDED line proves itself with a quoted fragment. A quote mark inside the NAME sitting on
    // that line is a second opening quote the checker can pair with.
    expect(cleanName('the "big" `fix`')).toBe('the big fix');
  });

  it('collapses to one line, because a wrapped name fuses into the decision', () => {
    expect(cleanName('dead weight,\n  live bugs')).toBe('dead weight, live bugs');
  });

  it('caps length so a name cannot crowd out the payload it labels', () => {
    const out = cleanName('x'.repeat(200));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(48);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('rejects a name with nothing in it', () => {
    for (const empty of ['', '   ', '\n\n', '""', '``']) expect(cleanName(empty)).toBeNull();
  });
});

describe('readName / writeName', () => {
  it('round-trips a name through disk', () => {
    const b = base(); const ts = folder(b, '2026-08-20T03-48-19');
    expect(writeName(b, ts, 'dead weight, live bugs')).toBe('dead weight, live bugs');
    expect(readName(b, ts)).toBe('dead weight, live bugs');
  });

  it('reads null for a handoff that was never named, and never throws', () => {
    const b = base(); const ts = folder(b, '2026-08-20T03-48-19');
    expect(readName(b, ts)).toBeNull();
    expect(readName(b, 'no-such-handoff')).toBeNull();
  });

  it('refuses to store an unusable name rather than writing an empty label', () => {
    const b = base(); const ts = folder(b, '2026-08-20T03-48-19');
    expect(writeName(b, ts, '   ')).toBeNull();
    expect(readName(b, ts)).toBeNull();
  });

  it('cleans on the way IN and on the way OUT', () => {
    // A name hand-written into the file by a human bypasses `writeName` entirely.
    const b = base(); const ts = folder(b, '2026-08-20T03-48-19');
    writeFileSync(join(b, ts, 'name.txt'), 'a "quoted"\nname\n');
    expect(readName(b, ts)).toBe('a quoted name');
  });
});

describe('handoffLabel', () => {
  it('prefers the name', () => {
    const b = base(); const ts = folder(b, '2026-08-17T20-01-36');
    writeName(b, ts, 'continuity is the product');
    expect(handoffLabel(b, ts, NOW)).toBe('continuity is the product');
  });

  it('falls back to the DATE, never to the stamp, when a handoff has no name', () => {
    const b = base(); const ts = folder(b, '2026-08-17T20-01-36');
    expect(handoffLabel(b, ts, NOW)).toBe('Aug 17 handoff');
  });

  it('falls back to the stamp only when it is not even a date — ugly beats unresolvable', () => {
    const b = base();
    expect(handoffLabel(b, 'not-a-stamp', NOW)).toBe('not-a-stamp');
  });
});

describe('nameCarriedRefs', () => {
  const withHandoff = (name?: string) => {
    const b = base(); const ts = folder(b, '2026-08-17T20-01-36');
    if (name) writeName(b, ts, name);
    return b;
  };

  it('shows a carried citation by the name of the handoff it points at', () => {
    const b = withHandoff('continuity is the product');
    expect(nameCarriedRefs('locked earlier. `2026-08-17T20-01-36:L92`: "yes"', b, NOW))
      .toBe('locked earlier. `continuity is the product · L92`: "yes"');
  });

  it('falls back to the date when the handoff exists but was never named', () => {
    expect(nameCarriedRefs('`2026-08-17T20-01-36:L92`', withHandoff(), NOW))
      .toBe('`Aug 17 handoff · L92`');
  });

  it('KEEPS the stamp when the handoff is gone — an unresolvable ref must stay addressable', () => {
    const b = base(); // no folder at all
    expect(nameCarriedRefs('`2026-08-17T20-01-36:L92`', b, NOW)).toBe('`2026-08-17T20-01-36:L92`');
  });

  it('leaves a bare this-session ref alone', () => {
    // `L92` with no stamp points into the transcript being read right now; there is no other
    // handoff to name, and rewriting it would invent a provenance the line does not claim.
    expect(nameCarriedRefs('`L92`: "yes"', withHandoff('x'), NOW)).toBe('`L92`: "yes"');
  });

  it('does not touch the folder PATHS a reader still needs to open', () => {
    const src = 'see .delulu-handoff/2026-08-17T20-01-36/context.md for depth';
    expect(nameCarriedRefs(src, withHandoff('continuity is the product'), NOW)).toBe(src);
  });

  it('renames every ref on a line, not just the first', () => {
    const b = withHandoff('continuity is the product');
    expect(nameCarriedRefs('`2026-08-17T20-01-36:L92` and `2026-08-17T20-01-36:L96`', b, NOW))
      .toBe('`continuity is the product · L92` and `continuity is the product · L96`');
  });
});

describe('nameTitle', () => {
  it('shows the payload title by name instead of the stamp it was captured under', () => {
    const b = base(); const ts = folder(b, '2026-08-20T03-48-19');
    writeName(b, ts, 'dead weight, live bugs');
    expect(nameTitle('# delulu handoff — delulu · 2026-08-20T03-48-19', b, NOW))
      .toBe('# delulu handoff — delulu · dead weight, live bugs');
  });

  it('falls back to the date for an unnamed handoff', () => {
    const b = base(); folder(b, '2026-08-20T03-48-19');
    expect(nameTitle('# delulu handoff — delulu · 2026-08-20T03-48-19', b, NOW))
      .toBe('# delulu handoff — delulu · Aug 20');
  });

  it('leaves a line that is not a delulu title alone', () => {
    const b = base(); folder(b, '2026-08-20T03-48-19');
    for (const src of ['## What you said · 2026-08-20T03-48-19', 'see 2026-08-20T03-48-19'])
      expect(nameTitle(src, b, NOW)).toBe(src);
  });
});
