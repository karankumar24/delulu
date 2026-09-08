// Carrying a constraint across a session boundary, and being TOLD when one does not make it.
//
// The gap under test is the one between surfacing and enforcing. The engine writes the previous
// session's rulings into the draft as a comment, and the agent deletes that comment and re-authors
// the blocks itself — so "delulu offered it" and "the handoff kept it" were never the same
// statement, and nothing checked the difference.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { CLOSER, SECTION } from './payload';

// Loaded lazily, and only by the unit block below. A static import of a module that does not exist
// takes the WHOLE file down with it, and the four CLI tests at the bottom describe behaviour a user
// can see — they are worth failing on their own assertions rather than on someone else's import.
type CarryApi = typeof import('./carry');
let carry: CarryApi;

const APP = process.cwd();
const BUNDLES = mkdtempSync(join(tmpdir(), 'delulu-carry-bundle-'));
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

/** A complete, sealed-looking payload. `holds`/`decided` are block BODIES. */
function payload({ holds = '', decided = '' }: { holds?: string; decided?: string }): string {
  return `# delulu handoff — proj · stamp

## ${SECTION.state} — read at capture
- Branch \`main\` @ \`abc1234\` · tree clean

## ${SECTION.said} — every message you sent, in order
- \`L12\` "continuity is the product"
- \`L20\` "delete the stale cache"

---
> **Everything below this line is the last session's agent writing from memory, and delulu could not check any of it.**

## ${SECTION.holds}
${holds}

## ${SECTION.thread}
Mid-thought about the boundary.

## ${SECTION.decided}
${decided}

## ${SECTION.next}
Grep for \`droppedCarried\`.

---
${CLOSER}. Ask me about anything that's missing before you get going.
`;
}

function repoWith(payloads: Record<string, string>): string {
  scratch = mkdtempSync(join(tmpdir(), 'delulu-carry-'));
  for (const [ts, body] of Object.entries(payloads)) {
    mkdirSync(join(scratch, '.delulu-handoff', ts), { recursive: true });
    writeFileSync(join(scratch, '.delulu-handoff', ts, 'payload.md'), body);
  }
  return scratch;
}

const base = (repo: string) => join(repo, '.delulu-handoff');
const load = (repo: string, pick?: string): string =>
  spawnSync('node', [RESUME, '--repo', repo, ...(pick ? [pick] : [])], { encoding: 'utf8' }).stdout;

const typed = (text: string) =>
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
const asst = (text: string) =>
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;

function capture(repo: string, lines: string[]): { folder: string; log: string; path: string } {
  const log = join(repo, `session-${readdirSync(repo).length}.jsonl`);
  writeFileSync(log, lines.join('\n') + '\n');
  const dir = base(repo);
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  execFileSync('node', [HANDOFF, '--repo', repo, '--log', log], { encoding: 'utf8', env: CLEAN_ENV });
  const folder = readdirSync(dir).find((f) => !before.has(f))!;
  return { folder, log, path: join(dir, folder, 'payload.md') };
}

const restate = (repo: string, folder: string, log: string): string =>
  execFileSync('node', [HANDOFF, '--repo', repo, '--log', log, '--restate', folder], { encoding: 'utf8', env: CLEAN_ENV });

// A rule that KEEPS its place: it says, on the line, why no check could hold it. That claim is now
// what makes a drop worth alarming about — carrying is no longer the default for anything else.
const RULE = '- Continuity is the product. `2026-01-01T00-00-01:L12`: "continuity is the product" — cannot be a check: no test can hold what a product is for';
// The same line WITHOUT that claim. Dropping it is the correct outcome and must stay quiet.
const UNJUSTIFIED = '- Continuity is the product. `2026-01-01T00-00-01:L12`: "continuity is the product"';
// A BARE ref, deliberately: that is the shape a decision first locked in the handoff being carried
// FROM actually has, and it is what makes it unproven. The engine re-addresses it on the way out,
// which is exactly why `proven` has to be decided before that happens.
const SPENT = '- Delete the stale cache. `L20`: "delete the stale cache"';

// ---------------------------------------------------------------------------------------------

describe('what the previous handoff offered, and what this one kept', () => {
  beforeAll(async () => { carry = await import('./carry'); });
  it('names a constraint that had already crossed a boundary and is now gone', () => {
    const repo = repoWith({
      '2026-01-01T00-00-02': payload({ holds: RULE }),
      '2026-01-01T00-00-03': payload({ decided: '- Something else entirely. `L99`: "other"' }),
    });
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ decided: '- Something else. `L99`: "other"' }))!;
    expect(loss.lost.map((l) => l.text)).toEqual([expect.stringContaining('Continuity is the product')]);
    expect(carry.carryItems(loss, 'the earlier one').lost[0]).toContain('not in this handoff');
  });

  // The change that makes the block survivable. Dropping a line whose constraint belongs in a test
  // is now CORRECT, so it is counted, not shouted about. On the session that emptied a 29-line
  // block the old alarm fired 29 times, every one on a drop the user had just chosen — and an alarm
  // that is always wrong is one nobody reads.
  it('stays quiet when a line that never claimed to be unenforceable is dropped', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: UNJUSTIFIED }) });
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ decided: '- New work. `L99`: "new"' }))!;
    expect(loss.lost, 'a line with no stated reason must not raise the alarm').toEqual([]);
    expect(loss.routine).toBe(1);
  });

  // The other end of the same rule: reporting losses is worthless if anything may be added back
  // unexamined, which is how the block reached 29 lines while every session looked reasonable.
  it('names a rule kept without saying why no check could hold it', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ holds: UNJUSTIFIED }))!;
    expect(loss.unjustified).toEqual([expect.stringContaining('Continuity is the product')]);
    expect(carry.carryItems(loss, 'the earlier one').unjustified[0]).toContain('cannot be a check');
  });

  it('says nothing about a rule that DOES give its reason', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ holds: RULE }))!;
    expect(loss.unjustified).toEqual([]);
    expect(loss.lost).toEqual([]);
  });

  // Spent decisions are never asked to defend themselves — they do not reach another context.
  it('asks nothing of a line filed under this session’s decisions', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ holds: RULE, decided: UNJUSTIFIED }))!;
    expect(loss.unjustified).toEqual([]);
  });

  it('says nothing when the constraint was kept, even in the OTHER block', () => {
    // Filing a rule under the block that dies is a SORTING problem, reported separately. It is not
    // a loss, and reporting it as one would train the reader to ignore the loss report.
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const kept = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ decided: RULE }))!;
    expect(kept.lost).toEqual([]);
  });

  it('matches by REF, so rewording the summary in front of the quote is not a loss', () => {
    // The agent is told to copy verbatim and does not; the sentence is its own prose. The
    // `<stamp>:L<n>` ref is the one token that cannot be paraphrased and still mean the same thing.
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const reworded = '- Continuity, not correctness, is what this tool sells. `2026-01-01T00-00-01:L12`: "continuity is the product"';
    expect(carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ holds: reworded }))!.lost).toEqual([]);
  });

  it('counts a spent directive rather than naming it — only the survivor is alarming', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ decided: `${SPENT}\n- Ship it. \`L21\`: "ship"` }) });
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', payload({ decided: '- New work. `L99`: "new"' }))!;
    expect(loss.lost).toEqual([]);
    expect(loss.routine).toBe(2);
    const items = carry.carryItems(loss, 'the earlier one');
    expect(items.lost).toEqual([]);
    expect(items.routineNote).toContain('count rather than a list');
  });

  // POSITIVE CATCH — RED before the `untouched` check was scoped to the comment opener.
  //
  // Two handoffs identical but for ONE SENTENCE of the agent's own prose. Both worked the carried
  // block through, both dropped the same standing rule. The bare substring search set `untouched`
  // on the second, and `carryItems` then returned the all-clear INSTEAD of the loss — so the rule
  // vanished under a statement that nothing had been promoted out of the block.
  //
  // Reachable exactly where it hurts most: a session about delulu's own carry mechanism.
  it('still names a lost rule when the agent’s prose happens to mention the marker', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const dropped = payload({ decided: '- Something else. `L99`: "other"' });
    const talksAboutIt = dropped.replace(
      'Mid-thought about the boundary.',
      `We spent the session on how the ${carry.CARRIED_MARKER} block reaches the next agent.`,
    );
    const loss = carry.droppedCarried(base(repo), '2026-01-01T00-00-03', talksAboutIt)!;
    expect(loss.untouched, 'prose is not an unworked block').toBe(false);
    expect(carry.carryItems(loss, 'the earlier one').lost[0]).toContain('Continuity is the product');
  });

  it('reports a draft nobody worked through as UNWORKED, not as nineteen losses', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const draft = `${payload({})}\n<!-- delulu:fill, CARRIED FORWARD: ... -->`;
    const items = carry.carryItems(carry.droppedCarried(base(repo), '2026-01-01T00-00-03', draft), 'the earlier one');
    expect(items.lost).toEqual([]);
    expect(items.untouchedNote).toContain('unworked');
  });

  it('is silent when there is no earlier handoff at all', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    expect(carry.droppedCarried(base(repo), '2026-01-01T00-00-02', payload({}))).toBeNull();
  });

  it('reads the newest handoff strictly OLDER than the one asked about', () => {
    // `resume <an older handoff>` must not be handed its own SUCCESSOR's rulings and then told it
    // dropped every one of them. The old test for this was "not the same folder", which is only
    // true when the caller is always asking about the newest — which `handoff` is and `resume`
    // is not.
    const repo = repoWith({
      '2026-01-01T00-00-01': payload({ holds: '- The oldest rule. `2020-01-01T00-00-00:L1`: "oldest"' }),
      '2026-01-01T00-00-02': payload({ decided: '- The middle one. `L5`: "middle"' }),
      '2026-01-01T00-00-03': payload({ decided: '- The newest one. `L9`: "newest"' }),
    });
    expect(carry.carriedCandidates(base(repo), '2026-01-01T00-00-02')!.stamp).toBe('2026-01-01T00-00-01');
  });

  it('never grades a handoff against its own carried comment', () => {
    // The comment delulu writes sits ABOVE the first ruling heading, so a payload that still
    // contains every candidate cannot pass the check by quoting delulu back at itself.
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const stillCommented = payload({}).replace(`## ${SECTION.holds}`, `<!-- ${RULE} -->\n\n## ${SECTION.holds}`);
    expect(carry.droppedCarried(base(repo), '2026-01-01T00-00-03', stillCommented)!.lost).toHaveLength(1);
  });
});

describe('the check runs at BOTH ends of the boundary', () => {
  it('tells the session that caused the loss, at the seal, while it can still be fixed', () => {
    const repo = repoWith({ '2026-01-01T00-00-02': payload({ holds: RULE }) });
    const { folder, log, path } = capture(repo, [typed('Carry on and finish the sort.'), asst('ok')]);
    // Work through the draft the way an agent does — and lose the rule while doing it.
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace(/<!-- delulu:fill[\s\S]*?-->/g, 'written up.')
      .replace(`## ${SECTION.decided}\nwritten up.`, `## ${SECTION.decided}\n- Something new. \`L12\`: "Carry on"`));
    const out = restate(repo, folder, log);
    expect(out).toContain('said a check could not hold it');
    expect(out).toContain('Continuity is the product');
    expect(out).toContain('Nothing is blocked');
  });

  it('tells the session that INHERITS it, because that is the one that can act', () => {
    const repo = repoWith({
      '2026-01-01T00-00-02': payload({ holds: RULE }),
      '2026-01-01T00-00-03': payload({ decided: '- Something new. `L20`: "delete the stale cache"' }),
    });
    const out = load(repo);
    expect(out).toContain('are NOT in this one');
    expect(out).toContain('Continuity is the product');
    expect(out).toContain('cannot tell a revocation from a slip');
  });

  it('does not spend the next session’s context on the drops that were CORRECT', () => {
    // Measured, not assumed: this one sentence pushed the largest stored handoff past the delivery
    // budget and cost it a whole block of real content. It is said at the seal instead.
    const repo = repoWith({
      '2026-01-01T00-00-02': payload({ decided: SPENT }),
      '2026-01-01T00-00-03': payload({ decided: '- Something new. `L20`: "delete the stale cache"' }),
    });
    const out = load(repo);
    expect(out).not.toContain('count rather than a list');
    expect(out).not.toContain('are NOT in this one');
  });

  it('names the handoff it came from, never its stamp', () => {
    const repo = repoWith({
      '2026-01-01T00-00-02': payload({ holds: RULE }),
      '2026-01-01T00-00-03': payload({ decided: '- Something new. `L20`: "delete the stale cache"' }),
    });
    const out = load(repo);
    expect(out).toContain('are NOT in this one');   // or the slice below asserts nothing
    const block = out.slice(out.indexOf('are NOT in this one'), out.indexOf('# delulu handoff'));
    expect(block).not.toContain('2026-01-01T00-00-02');
    expect(block).toContain('Jan 1 handoff');
  });
});
