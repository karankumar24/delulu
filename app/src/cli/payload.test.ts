// delulu — is a payload sound enough to hand forward?
//
// This module exists because `resume` and `pruneHandoffs` each had their own idea of "unfinished"
// and disagreed, so prune deleted a handoff resume had just called incomplete — printing
// "unfinished handoffs are never pruned" on the line that named the folder it removed. It was
// written to be the single definition, and then had no tests of its own.

import { describe, it, expect } from 'vitest';
import { isIncompletePayload, payloadProblem, AGENT_ZONE, SECTION, CLOSER } from './payload';

// Headings come from the registry, never spelled out here. A fixture that spells its own heading
// keeps testing the OLD name after a rename while the code has moved on — and for this module that
// is silent: `payloadProblem` would start passing every real payload as "not a delulu handoff".
const sound = [
  '# delulu handoff — demo',
  '',
  `## ${SECTION.state} — read from the real repo and disk when this was captured`,
  '- Branch `main` @ `abc1234` · tree clean',
  AGENT_ZONE.replace(/^\n/, '') + '** is the agent writing, and delulu could not check it.**',
  '',
  `## ${SECTION.thread}`,
  'We were mid-refactor on the parser.',
  '',
  `## ${SECTION.next}`,
  'Finish the parser split.',
  // The engine writes this line into every payload it creates (handoff.ts, the template), drafts
  // included, and all seven stored here carry it. The fixture omitted it, which made it a shape
  // production never actually emits — and `payloadProblem` now reads its absence as a cut file.
  '',
  '---',
  `${CLOSER}. Ask me about anything that's missing before you get going.`,
].join('\n');

describe('payloadProblem', () => {
  it('passes a sound, fully written payload', () => {
    expect(payloadProblem(sound)).toBe('');
    expect(isIncompletePayload(sound)).toBe(false);
  });

  it('catches a ZERO-BYTE payload instead of judging it complete', () => {
    // `''.split(/^##\s.*$/m).slice(1)` is `[]`, so `.some()` was false and an empty file passed —
    // then loaded as the newest handoff, silently shadowing the good one beside it.
    expect(payloadProblem('')).toBe('the payload file is empty');
    expect(payloadProblem('   \n  \n')).toBe('the payload file is empty');
    expect(isIncompletePayload('')).toBe(true);
  });

  it('catches a file that is not a delulu handoff at all', () => {
    expect(payloadProblem('# some other document\n\nwith prose')).toMatch(/missing the block delulu always writes first/);
  });

  it('catches a payload truncated after the STATE block', () => {
    // Reachable for real: a crash or a full disk between writing STATE and writing the rest.
    const cut = sound.slice(0, sound.indexOf(AGENT_ZONE.slice(1)));
    expect(payloadProblem(cut)).toMatch(/stops before the agent-written sections/);
    expect(isIncompletePayload(cut)).toBe(true);
  });

  it('catches placeholders the agent never filled in', () => {
    const unfilled = sound.replace('We were mid-refactor on the parser.', '<!-- delulu:fill — what happened -->');
    expect(payloadProblem(unfilled)).toBe('some sections were never filled in');
  });

  it('counts blank agent sections, and says how many', () => {
    // Inserted BEFORE the closing line, which is where a real section lives — appending after it
    // modelled a payload the engine never writes, and the closer is now cut off before the count so
    // that an emptied final section can be seen at all.
    // NOT a ruling block for the second one: those may legitimately be empty (a session that locked
    // no standing rules, or no one-off directives, is a real session) and are exempt from this
    // count. `read` is an ordinary agent section and is not.
    const blank = sound
      .replace('Finish the parser split.', '')
      .replace(`---\n${CLOSER}`, `## ${SECTION.read}\n\n---\n${CLOSER}`);
    const problem = payloadProblem(blank);
    expect(problem).toMatch(/section\(s\) were left blank/);
    expect(problem).toMatch(/^2 /);
  });

  it('never flags the ENGINE zone, only the agent zone', () => {
    // The engine blocks above the fence are never blank by construction, and flagging them would
    // put a false "incomplete" on a sound handoff — a false red, which delulu does not do.
    const emptyEngineSection = sound.replace('- Branch `main` @ `abc1234` · tree clean', '');
    expect(payloadProblem(emptyEngineSection)).toBe('');
  });

  it('reports the FIRST and most fundamental problem when several apply', () => {
    // Order matters: telling someone their sections are blank when the file is empty is noise.
    expect(payloadProblem('')).toBe('the payload file is empty');
    expect(payloadProblem('nothing useful here')).toMatch(/missing the block delulu always writes first/);
  });
});

describe('isIncompletePayload', () => {
  it('agrees with payloadProblem on every case — one definition, not two', () => {
    // The drift this module was created to end: two copies of the same ladder, in the file whose
    // header explains that two copies of this exact predicate drifted apart and deleted a handoff.
    const cases = ['', '   ', 'not ours', sound, sound.replace('We were mid-refactor on the parser.', '<!-- delulu:fill -->')];
    for (const c of cases) expect(isIncompletePayload(c)).toBe(payloadProblem(c) !== '');
  });
});

// A payload cut AFTER the fence had no signal at all: the truncation check above it only catches a
// cut BEFORE the agent zone, and the blank-section count needs a heading to be present-and-empty.
// Sections that are simply gone leave neither, so the file loaded clean.
describe('payloadProblem — a payload cut after the fence is not silent', () => {
  const whole = `# h\n\n## ${SECTION.state}\n- Branch \`main\`\n\n${AGENT_ZONE}\n\n`
    + `## ${SECTION.thread}\nwhere we stopped\n\n## ${SECTION.decided}\n- A ruling. \`L1\`\n\n`
    + `## ${SECTION.next}\ndo the thing\n\n${CLOSER}. Ask me about anything that's missing.\n`;

  it('accepts a complete payload — the check must not fire on the common path', () => {
    expect(payloadProblem(whole)).toBe('');
  });

  it('reports a payload whose trailing sections were cut off', () => {
    const cut = whole.slice(0, whole.indexOf(`## ${SECTION.next}`));
    expect(payloadProblem(cut)).toContain('cut short');
  });

  // The distinction that makes the message honest: an UNFINISHED handoff still has its closer, so
  // it must keep reporting as blank sections rather than as truncation.
  it('still calls an unfinished handoff unfinished, not cut short', () => {
    const blank = whole.replace('where we stopped', '');
    expect(payloadProblem(blank)).toContain('left blank');
    expect(payloadProblem(blank)).not.toContain('cut short');
  });
});
