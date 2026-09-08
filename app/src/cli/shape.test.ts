// WHAT DELULU IS, enforced rather than remembered.
//
// Two constraints the user has restated across sessions — "only two commands, handoff and resume"
// and "always a manual command, no hook, nothing that fires on its own" — lived only as sentences
// carried in a handoff's rules block. A sentence in a payload reaches exactly one place: a session
// that happens to resume. It cannot stop a third command being added, and it never did anything at
// all to a session that started cold.
//
// So they are checks now. The point is not that anyone was about to add a hook; it is that the
// rules block was the wrong home for a constraint that a test can hold, and every line still
// sitting there costs bytes in every resume while enforcing nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP = process.cwd();
const REPO = resolve(APP, '..');
const PLUGIN = join(REPO, 'plugin');

describe('delulu is two commands, and nothing else', () => {
  it('the dispatcher routes handoff and resume, and refuses to grow a third quietly', () => {
    const cli = readFileSync(join(PLUGIN, 'hook', 'cli.mjs'), 'utf8');
    // Every command the dispatcher can actually reach, read off the routing itself rather than
    // from a list somebody would have to remember to update.
    const routed = [...cli.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(routed, 'the dispatcher routes a command that is not handoff or resume').toEqual(['handoff', 'resume']);
  });

  it('ships exactly two slash commands', () => {
    const commands = readdirSync(join(PLUGIN, 'commands')).filter((f) => f.endsWith('.md')).sort();
    expect(commands).toEqual(['handoff.md', 'resume.md']);
  });

  it('the positive control — this test can fail', () => {
    // Without this, a regex that stops matching makes both assertions above pass on an empty list,
    // which is the failure this repo has shipped before: a check that could not go red.
    const fake = "if (cmd === 'handoff') {} else if (cmd === 'compress') {}";
    expect([...fake.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1])).toEqual(['handoff', 'compress']);
  });
});

describe('delulu never fires on its own', () => {
  it('the plugin registers no hooks', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(Object.keys(manifest)).not.toContain('hooks');
  });

  it('ships no hooks directory and no settings that could install one', () => {
    // A `hooks/` folder or a hooks block in settings is how a plugin arranges to run without being
    // asked. Neither may exist: delulu runs when a person types the command, and at no other time.
    expect(existsSync(join(PLUGIN, 'hooks')), 'plugin/hooks/ exists').toBe(false);
    for (const f of ['settings.json', 'hooks.json']) {
      expect(existsSync(join(PLUGIN, f)), `plugin/${f} exists`).toBe(false);
    }
  });

  it('the command files invoke delulu directly, never via an event', () => {
    // `allowed-tools` is what the slash command may run. A command that could register a hook, or
    // that reaches for anything beyond running node and reading files, is a command that could
    // arrange to fire later.
    for (const f of ['handoff.md', 'resume.md']) {
      const text = readFileSync(join(PLUGIN, 'commands', f), 'utf8');
      const front = text.slice(0, text.indexOf('---', 3));
      expect(front, `${f} front matter mentions hooks`).not.toMatch(/hook/i);
    }
  });
});
