// The DECIDED split: one bucket that held three lifetimes became two blocks with one lifetime each.
//
// What is under test is not "a heading was added". It is the four silent failures a section rename
// can cause here — a citation check that finds nothing and reports a clean bill, a delivery trimmer
// that stops recognising a block, a prune predicate that calls a sound handoff damaged, and a
// carry-forward that walks past a handoff it should have carried from. Every one of them exits 0.
//
// It also pins the two properties the split is FOR: a rule is undroppable, and a rule is carried
// until the user revokes it — never until it looks old.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import {
  BLOCK_SHARES, CLOSER, DECIDED_BEFORE_SPLIT, DELIVERY_DROP_ORDER, PREAMBLE_RESERVE, RULING_SECTIONS, SAFE_PAYLOAD_BYTES,
  SECTION, SHARE_NOISE_FLOOR, overShare, shareReport,
  classifyRuling, deliveryBytes, isIncompletePayload, payloadProblem,
} from './payload';
import { checkCitations, citationNotice, decidedEntries, decidedLines } from './citations';

const APP = process.cwd();

// Bundle the SOURCE. `hook/*.mjs` are build artifacts that only track src/ when someone remembers
// to run the build, so asserting against them proves a stale copy still behaves.
const BUNDLES = mkdtempSync(join(tmpdir(), 'delulu-holds-bundle-'));
const RESUME = join(BUNDLES, 'resume.mjs');
const HANDOFF = join(BUNDLES, 'handoff.mjs');
beforeAll(async () => {
  const common = { bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node22', logLevel: 'silent' as const };
  await build({ ...common, entryPoints: [resolve(APP, 'src/cli/resume.ts')], outfile: RESUME });
  await build({ ...common, entryPoints: [resolve(APP, 'src/cli/handoff.ts')], outfile: HANDOFF });
});
afterAll(() => rmSync(BUNDLES, { recursive: true, force: true }));

let scratch: string | null = null;
afterEach(() => { if (scratch) { rmSync(scratch, { recursive: true, force: true }); scratch = null; } });

const CLEAN_ENV = (() => { const e = { ...process.env }; delete e.CLAUDE_CODE_SESSION_ID; return e; })();

/**
 * A heading, or a loud failure — never the string "undefined".
 *
 * Every assertion here reads its headings out of the registry instead of spelling them, which is
 * this file's rule and the codebase's. The cost is that a registry MISSING the new heading turns
 * those assertions into comparisons against `"undefined"`, several of which then pass over a
 * feature that does not exist. A test that cannot fail is worse than no test, so the headings that
 * carry an assertion's meaning are read through here.
 */
const heading = (name: string): string => { expect(typeof name).toBe('string'); return name; };

const FENCE = `---
> **Everything below this line is the last session's agent writing from memory, and delulu could not check any of it.**`;

/** A whole payload, agent zone and all. `holds`/`decided` are block BODIES, not headings. */
function payload({ holds, decided, thread = 'mid-thought about the auth bug.', next = 'Grep for `carriedCandidates`, because the sort runs there.' }:
  { holds?: string; decided?: string; thread?: string; next?: string }): string {
  return `# delulu handoff — proj · 2026-01-01T00-00-01

## ${SECTION.state} — read at capture
- Branch \`main\` @ \`abc1234\` · tree clean

## ${SECTION.said} — every message you sent, in order
- \`L12\` "never ship without the citation check"
- \`L20\` "delete the stale cache"

${FENCE}
${holds === undefined ? '' : `\n## ${SECTION.holds}\n${holds}\n`}
## ${SECTION.thread}
${thread}
${decided === undefined ? '' : `\n## ${SECTION.decided}\n${decided}\n`}
## ${SECTION.next}
${next}

---
${CLOSER}. Ask me about anything that's missing before you get going.
`;
}

/** The same file as a handoff sealed BEFORE the split — one block, under the old name. */
function sealedBeforeSplit(decided: string): string {
  return payload({}).replace(`## ${SECTION.thread}`, `## ${DECIDED_BEFORE_SPLIT}\n${decided}\n\n## ${SECTION.thread}`);
}

function repoWith(payloads: Record<string, string>): string {
  scratch = mkdtempSync(join(tmpdir(), 'delulu-holds-'));
  for (const [ts, body] of Object.entries(payloads)) {
    mkdirSync(join(scratch, '.delulu-handoff', ts), { recursive: true });
    writeFileSync(join(scratch, '.delulu-handoff', ts, 'payload.md'), body);
  }
  return scratch;
}

const load = (repo: string): string => spawnSync('node', [RESUME, '--repo', repo], { encoding: 'utf8' }).stdout;

const typed = (text: string) =>
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
const asst = (text: string) =>
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;

/** Capture a handoff in `repo` from an inline transcript; returns the new folder and its payload. */
function capture(repo: string, lines: string[]): { folder: string; payload: string; log: string; stdout: string } {
  const log = join(repo, `session-${readdirSync(repo).length}.jsonl`);
  writeFileSync(log, lines.join('\n') + '\n');
  const dir = join(repo, '.delulu-handoff');
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const stdout = execFileSync('node', [HANDOFF, '--repo', repo, '--log', log], { encoding: 'utf8', env: CLEAN_ENV });
  const folder = readdirSync(join(repo, '.delulu-handoff')).find((f) => !before.has(f))!;
  return { folder, payload: readFileSync(join(repo, '.delulu-handoff', folder, 'payload.md'), 'utf8'), log, stdout };
}

// ---------------------------------------------------------------------------------------------

describe('the two blocks exist and have different lifetimes', () => {
  it('names the permanent block so that it carries its own caveat', () => {
    // The name is the mitigation for this design's sharpest risk — a stale rule outranking a fresh
    // judgement BECAUSE it has a citation — so the name is behaviour, not decoration, exactly as
    // "(unchecked)" is on the agent's-read block.
    expect(SECTION.holds).toBe('What holds until you say otherwise');
    expect(SECTION.decided).toBe('What you decided this session');
  });

  it('makes the rules block UNDROPPABLE — a rule a size guard can delete is not a rule', () => {
    // Graded like a ruling block, and absent from the drop order. Both halves matter: the first
    // says its lines are held to the citation standard, the second says a size guard can never
    // silently delete one of them.
    expect(RULING_SECTIONS).toContain(SECTION.holds);
    expect(DELIVERY_DROP_ORDER).not.toContain(SECTION.holds);
    // And the block that is meant to die is still droppable, under BOTH its names.
    expect(DELIVERY_DROP_ORDER).toContain(SECTION.decided);
  });
});

describe('a payload with no standing rules is SOUND, not damaged', () => {
  // This is not cosmetic. `isIncompletePayload` is `payloadProblem(text) !== ''`, and it governs
  // prune AND carry-forward: counting an empty rules block as damage would make the NEXT capture
  // walk straight past this handoff when it looks for decisions to carry, which is the failure the
  // whole split exists to fix, arriving through the fix itself.
  it('does not count an empty rules block as a section left blank', () => {
    const body = payload({ holds: '', decided: '- Delete the cache. `L20`: "delete the stale cache"' });
    expect(payloadProblem(body)).toBe('');
    expect(isIncompletePayload(body)).toBe(false);
  });

  it('still counts every OTHER empty section as blank', () => {
    const body = payload({ holds: '- Never ship without the check. `L12`: "never ship without"', thread: '' });
    expect(payloadProblem(body)).toContain('left blank');
  });

  it('still catches a rules block the agent never filled in', () => {
    const body = payload({ holds: '<!-- delulu:fill — the rules that outlive this session -->' });
    expect(payloadProblem(body)).toContain('never filled in');
  });
});

describe('the citation check grades BOTH blocks', () => {
  const holds = '- Never ship without the citation check. `L12`: "never ship without the citation check"';
  const decided = '- Delete the stale cache. `L20`: "delete the stale cache"';

  it('reads rulings out of both, tagged with the block each came from, in file order', () => {
    const e = decidedEntries(payload({ holds, decided }));
    expect(e.map((x) => x.section)).toEqual([SECTION.holds, SECTION.decided]);
    expect(decidedLines(payload({ holds, decided }))).toHaveLength(2);
  });

  it('reports a fabricated citation under the RULES block — the worse of the two to get wrong', () => {
    const fabricated = '- All work stops on Fridays, permanently. `L999`: "stop on fridays"';
    const r = checkCitations(payload({ holds: fabricated, decided }), [12, 20], { 12: 'never ship without the citation check', 20: 'delete the stale cache' });
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].section).toBe(SECTION.holds);
    expect(citationNotice(r)).toContain(`under "${SECTION.holds}"`);
  });

  it('names the block a finding is actually in, not both blocks by reflex', () => {
    const r = checkCitations(payload({ holds, decided: '- An inference filed as a ruling, with nothing behind it.' }), [12, 20], { 12: 'never ship without the citation check' });
    const notice = citationNotice(r);
    expect(r.uncited[0].section).toBe(SECTION.decided);
    expect(notice).toContain(`under "${SECTION.decided}"`);
    expect(notice).not.toContain(heading(SECTION.holds));
  });

  it('does not grade one heading twice because the old name is a PREFIX of the new one', () => {
    // `What you decided` is a prefix of `What you decided this session`, and heading matching
    // deliberately allows a trailing gloss — so a matcher that searched per NAME would find the
    // same physical heading under both and report every finding on it twice.
    const two = '- One. `L12`: "never ship"\n- Two. `L20`: "delete the stale cache"';
    const e = decidedEntries(payload({ decided: two }));
    expect(e).toHaveLength(2);
    expect(new Set(e.map((x) => x.section))).toEqual(new Set([SECTION.decided]));
  });

  it('never fuses the last rule of one block onto the first decision of the next', () => {
    // A continuation line is joined to the decision above it. Run across both bodies at once, that
    // join reaches across the section boundary and invents one ruling out of two.
    const e = decidedEntries(payload({ holds: '- A standing rule. `L12`: "never ship"', decided: '- A spent decision. `L20`: "delete the stale cache"' }));
    expect(e).toHaveLength(2);
    expect(e[0].text).not.toContain('spent decision');
  });
});

describe('a handoff sealed before the split is still read, and still described by ITS name', () => {
  const legacy = sealedBeforeSplit('- An inference filed as a ruling, with no citation on it at all.');

  it('still finds the rulings under the old heading', () => {
    expect(decidedLines(legacy)).toHaveLength(1);
    expect(decidedEntries(legacy)[0].section).toBe(DECIDED_BEFORE_SPLIT);
  });

  it('quotes the heading the file actually carries, never one invented after it was sealed', () => {
    const notice = citationNotice(checkCitations(legacy, [12]));
    expect(notice).toContain(`under "${DECIDED_BEFORE_SPLIT}"`);
    expect(notice).not.toContain('this session');
  });

  it('keeps the old block DROPPABLE, so an oversized sealed handoff is still trimmed on purpose', () => {
    const bulk = (n: number) => `${'a sentence that exists only to spend bytes. '.repeat(n)}`;
    const big = sealedBeforeSplit(bulk(900)).replace(`## ${SECTION.thread}`, `## ${SECTION.thread}`);
    expect(deliveryBytes(big)).toBeGreaterThan(30_000);
    const out = load(repoWith({ '2026-01-01T00-00-01': big }));
    expect(out).toContain('too big to send whole');
    expect(out).toContain(DECIDED_BEFORE_SPLIT);          // named in the notice
    expect(out).not.toContain(`## ${DECIDED_BEFORE_SPLIT}`); // and actually left out
  });
});

describe('classifyRuling — a guess made from the words, not from an opinion', () => {
  const hop = '- Continuity is the product. `2026-08-17T20-01-36:L92`: "continuity is the product"';
  it('treats a line that has survived a session boundary as permanent', () => {
    expect(classifyRuling(hop)).toBe('rules');
  });
  it('treats a line that READS as a standing rule as permanent', () => {
    expect(classifyRuling('- The folder stamp must never be printed to a human. `L190`: "this part looks badd"')).toBe('rules');
    expect(classifyRuling('- Always ask before dispatching. `L427`: "check with me"')).toBe('rules');
  });
  it('treats a line naming one file, path or commit as spent with the session', () => {
    expect(classifyRuling('- Delete `~/.delulu` outright. `L1110`: "Delete it outright"')).toBe('session');
    expect(classifyRuling('- Ship from `a7636cc`. `L12`: "ship it"')).toBe('session');
  });
  it('lets the rule reading WIN when a line is both', () => {
    expect(classifyRuling('- Never edit `app/src/cli/payload.ts` by hand. `L12`: "never edit it"')).toBe('rules');
  });
  it('says UNSORTED rather than guessing — the outcome that changes nothing', () => {
    expect(classifyRuling('- Less displayed output. `L1034`: "the less the displayed stuff"')).toBe('unsorted');
  });
  it('keeps a line that was already in the rules block there, without re-earning it', () => {
    // A rule leaves when the user revokes it. Making it re-qualify every session is silent decay.
    expect(classifyRuling('- Less displayed output. `L1034`: "the less the displayed stuff"', SECTION.holds)).toBe('rules');
  });
  it('does not let a bare citation ref look like a filename', () => {
    expect(classifyRuling('- Something with no signal at all. `L412`: "ok"')).toBe('unsorted');
  });

  it('does not let a stamp promote a line the user filed as SPENT', () => {
    // The stamp says the line was CARRIED, not that it endures. Read as durability it laundered a
    // one-off into a standing rule in a single hop: measured on a real capture, `Ship the stage-2
    // tree today, then stop.` was filed under DECIDED and came back offered under STILL HOLDS.
    const spent = '- Ship the stage-2 tree today, then stop. `2026-07-01T00-00-01:L9`: "ship stage 2 today"';
    expect(classifyRuling(spent, SECTION.decided)).toBe('unsorted');
    // The same line from the RULES block is a rule, because that is where the user put it.
    expect(classifyRuling(spent, SECTION.holds)).toBe('rules');
    // And with no section to go on, the hop signal is all there is, so it still applies.
    expect(classifyRuling(spent)).toBe('rules');
  });

  it('still promotes a filed-as-spent line that genuinely READS like a rule', () => {
    // Muted, not inverted. Wording is signal 3 and it survives — which is the case the promotion
    // was there for in the first place.
    const shaped = '- Never edit `app/src/cli/payload.ts` by hand. `2026-07-01T00-00-01:L12`: "never edit it"';
    expect(classifyRuling(shaped, SECTION.decided)).toBe('rules');
  });
});

describe('capture — the draft, and the pre-sorted carry-forward', () => {
  it('writes the rules block into every draft, ABOVE the conversation it frames', () => {
    const repo = repoWith({});
    const { payload: p } = capture(repo, [typed('Refactor the auth module and keep the API stable.'), asst('on it')]);
    expect(p).toContain(`## ${SECTION.holds}`);
    expect(p.indexOf(`## ${SECTION.holds}`)).toBeGreaterThan(p.indexOf('Everything below this line'));
    expect(p.indexOf(`## ${SECTION.holds}`)).toBeLessThan(p.indexOf(`## ${SECTION.thread}`));
  });

  it('pre-sorts the carried rulings into labelled groups, keeping their ORIGINAL refs', () => {
    const prior = payload({
      holds: '- Continuity is the product. `2026-08-17T20-01-36:L92`: "continuity is the product"',
      decided: [
        '- Agents must be brutal and fresh. `L65`: "must think on their own"',
        '- Delete `~/.delulu` outright. `L1110`: "Delete it outright"',
        '- Less displayed output. `L1034`: "the less the displayed stuff"',
      ].join('\n'),
    });
    const repo = repoWith({ '2026-01-01T00-00-01': prior });
    const { payload: p } = capture(repo, [typed('Carry on from the last handoff and finish the sort.'), asst('ok')]);

    expect(p).toContain('CARRIED FORWARD');
    const block = p.slice(p.indexOf('CARRIED FORWARD'), p.indexOf(`## ${SECTION.holds}`));
    const at = (s: string) => block.indexOf(s);
    expect(at('STILL HOLDS')).toBeGreaterThan(-1);
    expect(at('NO SIGNAL')).toBeGreaterThan(-1);
    expect(at('PROBABLY SPENT')).toBeGreaterThan(-1);
    // Survived a hop, and reads as a rule: both under STILL HOLDS.
    expect(at('Continuity is the product')).toBeGreaterThan(at('STILL HOLDS'));
    expect(at('Continuity is the product')).toBeLessThan(at('NO SIGNAL'));
    expect(at('Agents must be brutal')).toBeLessThan(at('NO SIGNAL'));
    // Names a path: spent.
    expect(at('Delete `~/.delulu`')).toBeGreaterThan(at('PROBABLY SPENT'));
    // No signal: offered exactly as before the split existed.
    expect(at('Less displayed output')).toBeGreaterThan(at('NO SIGNAL'));
    expect(at('Less displayed output')).toBeLessThan(at('PROBABLY SPENT'));
    // The ref locked five sessions ago still addresses the session that holds the words.
    expect(block).toContain('`2026-08-17T20-01-36:L92`');
    // And a bare ref is re-addressed to the handoff it was read from, never left ambiguous.
    expect(block).toContain('`2026-01-01T00-00-01:L1110`');
  });

  it('carries forward from a handoff whose rules block is EMPTY', () => {
    // The regression this guards: an empty rules block reading as "incomplete" makes carry-forward
    // skip the handoff entirely, so every decision in it is lost — silently, exit 0.
    const prior = payload({ holds: '', decided: '- Agents must be brutal. `L65`: "must think on their own"' });
    const repo = repoWith({ '2026-01-01T00-00-01': prior });
    const { payload: p } = capture(repo, [typed('Continue the work from last time.'), asst('ok')]);
    expect(p).toContain('CARRIED FORWARD');
    expect(p).toContain('Agents must be brutal');
  });

  it('asks — never moves — when a line reads like it is in the wrong block, at seal time', () => {
    const repo = repoWith({});
    const { folder, log } = capture(repo, [typed('Lock the rule that we never ship without the citation check.'), asst('ok')]);
    const path = join(repo, '.delulu-handoff', folder, 'payload.md');
    const drafted = readFileSync(path, 'utf8');
    // Fill every placeholder, filing a standing rule under the block that dies.
    const filled = drafted
      .replace(/<!-- delulu:fill[\s\S]*?-->/g, 'written up.')
      .replace('written up.\n\n## ' + SECTION.decided, 'written up.\n\n## ' + SECTION.decided)
      .replace(`## ${SECTION.decided}\nwritten up.`, `## ${SECTION.decided}\n- We must never ship without the citation check. \`L12\`: "never ship without the citation check"`);
    writeFileSync(path, filled);
    const out = execFileSync('node', [HANDOFF, '--repo', repo, '--log', log, '--restate', folder], { encoding: 'utf8', env: CLEAN_ENV });
    expect(out).toContain('may be in the wrong block');
    expect(out).toContain(SECTION.holds);
    expect(out).toContain('nothing was moved');
    // And it really did not move anything.
    expect(readFileSync(path, 'utf8')).toContain(`## ${SECTION.decided}\n- We must never ship`);
  });
});

describe('load — the rules survive the pipe, and frame what is read after them', () => {
  const rule = '- Never ship without the citation check. `L12`: "never ship without the citation check"';

  it('keeps the rules block when everything droppable has been dropped', () => {
    const filler = (n: number) => 'a sentence that exists only to spend delivery bytes. '.repeat(n);
    const big = payload({ holds: rule, decided: `- Delete the cache. \`L20\`: "delete the stale cache"\n${filler(700)}` })
      .replace(`## ${SECTION.next}`, `## ${SECTION.read}\n${filler(200)}\n\n## ${SECTION.next}`);
    expect(deliveryBytes(big)).toBeGreaterThan(30_000);
    const out = load(repoWith({ '2026-01-01T00-00-01': big }));
    expect(out).toContain('too big to send whole');
    expect(out).not.toContain(`## ${SECTION.decided}`);   // the block that dies was dropped
    expect(out).toContain(`## ${heading(SECTION.holds)}`); // the block that holds was not
    expect(out).toContain('Never ship without the citation check');
  });

  it('tells the next session the rules frame everything, and names both blocks', () => {
    const out = load(repoWith({ '2026-01-01T00-00-01': payload({ holds: rule, decided: '- Delete the cache. `L20`: "delete the stale cache"' }) }));
    expect(out).toContain(`Then "${SECTION.holds}", before the rest of the notes`);
    expect(out).toContain('only they retire one');
    expect(out).toContain(`Every line under "${SECTION.holds}" and "${SECTION.decided}" is only as good as the citation on it`);
  });

  it('says nothing about a rules block that is not there, or is empty', () => {
    const out = load(repoWith({ '2026-01-01T00-00-01': payload({ holds: '', decided: '- Delete the cache. `L20`: "delete the stale cache"' }) }));
    expect(out).not.toContain(`Then "${SECTION.holds}", before the rest`);
    expect(out).toContain(`Every line under "${SECTION.decided}" is only as good as`);
  });
});

describe('BLOCK_SHARES — a budget that is actually divided, not just declared', () => {
  it('sums to exactly the payload budget', () => {
    // The whole point. A table summing to MORE than the budget is not a budget, it is a wish: every
    // block passes its own check and the payload is over anyway, which is the state this repo's
    // library was already in — a ~29,000-byte median against 23,000 — with nothing reporting it.
    const total = Object.values(BLOCK_SHARES).reduce((a, b) => a + b, 0);
    expect(total).toBe(SAFE_PAYLOAD_BYTES);
  });

  it('covers every block a payload carries, so none can spend unmeasured', () => {
    // `subagents` is excluded deliberately: it lives only in context.md and never costs a delivery
    // byte. Every OTHER section must appear, or a block with no share is a block with no ceiling.
    const shared = new Set(Object.keys(BLOCK_SHARES));
    const payloadSections = Object.entries(SECTION).filter(([k]) => k !== 'subagents');
    for (const [key, name] of payloadSections)
      expect(shared.has(name), `${key} has no share`).toBe(true);
  });

  it('reserves more for the preamble than the largest one ever measured', () => {
    // The preamble is charged to the same output as the payload. Measured across all eight handoffs
    // in this repo it runs 1,779 to 3,358 bytes; the previous reserve was 2,000 and six of the
    // eight exceeded it. Under-reserving does not break delivery — that path measures the real
    // preamble — it makes the CAPTURE-time warning too permissive, so a payload passes the seal
    // check and arrives trimmed anyway.
    const LARGEST_MEASURED = 3_358;
    expect(PREAMBLE_RESERVE).toBeGreaterThanOrEqual(LARGEST_MEASURED);
    // And not so generous that the payload budget is being given away: the preamble is bounded,
    // because every provenance list is capped.
    expect(PREAMBLE_RESERVE).toBeLessThan(LARGEST_MEASURED * 2);
  });

  it('gives the rules block room to grow before it binds', () => {
    // 3,396 bytes on the handoff that prompted this, so the share must leave headroom for a rule or
    // two — a ceiling that binds the day it ships would fire the capture-time prompt every session
    // and teach the user to click past it.
    expect(BLOCK_SHARES[SECTION.holds]).toBeGreaterThan(3_396);
  });
});

describe('overShare — reports, and never cuts', () => {
  const heading = (name: string, bytes: number) => `## ${name}\n${'x'.repeat(bytes)}\n\n`;

  it('names a block past its share, with both numbers', () => {
    const over = BLOCK_SHARES[SECTION.elseWrong] + 500;
    const found = overShare(heading(SECTION.elseWrong, over));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe(SECTION.elseWrong);
    expect(found[0].share).toBe(BLOCK_SHARES[SECTION.elseWrong]);
    // Counted WITH the heading, because that is what the pipe counts.
    expect(found[0].bytes).toBeGreaterThan(over);
  });

  it('says nothing about a block inside its share', () => {
    expect(overShare(heading(SECTION.elseWrong, 100))).toEqual([]);
  });

  it('returns the text untouched — it is a report, not a trimmer', () => {
    // Guarding the property, not the return type: the day someone makes this "helpful" by
    // shortening the block, a rule gets silently deleted by a size guard and the whole reason
    // `holds` is absent from DELIVERY_DROP_ORDER is undone from a different direction.
    const text = heading(SECTION.said, BLOCK_SHARES[SECTION.said] + 1_000);
    const before = text;
    overShare(text);
    expect(text).toBe(before);
  });

  it('measures a pre-split handoff against the block it actually is', () => {
    // A sealed payload still says `What you decided`. Judged by its own name it matches no share
    // and looks compliant for ever; judged through `headingsFor` it is measured like the block it
    // is. Silent non-coverage of old handoffs is exactly how the other matchers in this file fail.
    const found = overShare(heading(DECIDED_BEFORE_SPLIT, BLOCK_SHARES[SECTION.decided] + 400));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe(SECTION.decided);
  });

  it('sorts by how far over, so the worst offender is named first', () => {
    const text = heading(SECTION.elseWrong, BLOCK_SHARES[SECTION.elseWrong] + 200)
      + heading(SECTION.said, BLOCK_SHARES[SECTION.said] + 5_000);
    expect(overShare(text).map((o) => o.name)).toEqual([SECTION.said, SECTION.elseWrong]);
  });
});

describe('the pointers block is the MAP, and goes last', () => {
  it('drops `more` after everything else, not before it', () => {
    // It was first for years, on the reasoning that a block recoverable from a path costs nothing.
    // What it points AT was 132KB on the handoff that prompted this change, and the payload is a
    // pointer into that. Losing the map to save 2,911 bytes is the worst trade in the list, and it
    // happened in the field on 2026-08-29.
    expect(DELIVERY_DROP_ORDER[DELIVERY_DROP_ORDER.length - 1]).toBe(SECTION.more);
    // And the user's own words still go second-to-last: a resume without them is a briefing.
    expect(DELIVERY_DROP_ORDER[DELIVERY_DROP_ORDER.length - 2]).toBe(SECTION.said);
  });

  it('keeps its share small enough that the trim should never reach it', () => {
    expect(BLOCK_SHARES[SECTION.more]).toBeLessThan(BLOCK_SHARES[SECTION.said]);
  });
});

describe('shareReport — says nothing until there is something to do about it', () => {
  const block = (name: string, bytes: number) => `## ${name}\n${'x'.repeat(bytes)}\n\n`;
  /** A payload of `total` bytes whose bulk sits in one named block. */
  const sized = (name: string, total: number) => block(name, total - `## ${name}\n\n\n`.length);

  it('is silent on a payload that fits, however the blocks divide it', () => {
    // The measured case this exists for: 2026-08-17T20-01-36 fits at 22,150 bytes with SIX blocks
    // above their shares. All six are borrowing room nobody else wanted. Reporting them would train
    // the reader to click past the report that matters.
    const text = block(SECTION.elseWrong, BLOCK_SHARES[SECTION.elseWrong] + 900)
      + block(SECTION.state, BLOCK_SHARES[SECTION.state] + 400);
    expect(deliveryBytes(text)).toBeLessThan(SAFE_PAYLOAD_BYTES);
    expect(overShare(text).length).toBe(2);      // both ARE over their share...
    expect(shareReport(text)).toEqual([]);       // ...and neither is worth a word.
  });

  it('names every block meaningfully over, worst first — not just enough to cover the excess', () => {
    // The regression this replaces: stopping once the arithmetic worked named `What you said` alone
    // on BOTH over-budget handoffs in this repo, and never mentioned `More, if you need it` at
    // 2,815 bytes against 600 — the easiest fix in the file. A report that hides the cheap cut
    // behind the painful one is worse than one line longer.
    const text = sized(SECTION.said, SAFE_PAYLOAD_BYTES + 1_200)
      + block(SECTION.more, BLOCK_SHARES[SECTION.more] + 900);
    expect(shareReport(text).map((o) => o.name)).toEqual([SECTION.said, SECTION.more]);
  });

  it('never names a block whose overrun is rounding', () => {
    const text = sized(SECTION.said, SAFE_PAYLOAD_BYTES + 5)
      + block(SECTION.state, BLOCK_SHARES[SECTION.state] + SHARE_NOISE_FLOOR - 1);
    expect(shareReport(text).every((o) => o.bytes - o.share >= SHARE_NOISE_FLOOR)).toBe(true);
  });

  it('reports enough to actually fix the overshoot', () => {
    // Two blocks, neither big enough alone. Naming a fix that does not fix it is worse than naming
    // nothing, because it reads like a complete answer.
    const half = Math.ceil((SAFE_PAYLOAD_BYTES + 2_000) / 2);
    const text = block(SECTION.said, half) + block(SECTION.read, half);
    const covered = shareReport(text).reduce((a, o) => a + o.bytes - o.share, 0);
    expect(covered).toBeGreaterThanOrEqual(deliveryBytes(text) - SAFE_PAYLOAD_BYTES);
  });
});
