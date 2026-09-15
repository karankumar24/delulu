// delulu is two manual commands and nothing that fires on its own, checked rather than remembered.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP = process.cwd();
const REPO = resolve(APP, '..');
const PLUGIN = join(REPO, 'plugin');

describe('delulu is two commands, and nothing else', () => {
  const invoked = (text: string) => [...text.matchAll(/\bnode\s+"[^"]*\/hook\/([\w-]+\.mjs)"/g)].map((m) => m[1]);

  it('each command file runs exactly its own script', () => {
    const run = (f: string) => invoked(readFileSync(join(PLUGIN, 'commands', f), 'utf8'));
    expect(run('handoff.md')).toEqual(['handoff.mjs']);
    expect(run('resume.md')).toEqual(['resume.mjs']);
  });

  it('ships exactly two slash commands and their two scripts', () => {
    const commands = readdirSync(join(PLUGIN, 'commands')).filter((f) => f.endsWith('.md')).sort();
    expect(commands).toEqual(['handoff.md', 'resume.md']);
    expect(readdirSync(join(PLUGIN, 'hook')).filter((f) => f.endsWith('.mjs')).sort()).toEqual(['handoff.mjs', 'resume.mjs']);
  });

  it('the positive control: this test can fail', () => {
    // Without this, a regex that stops matching would pass on an empty list.
    expect(invoked('node "${CLAUDE_PLUGIN_ROOT}/hook/compress.mjs" x')).toEqual(['compress.mjs']);
  });
});

describe('delulu never fires on its own', () => {
  it('the plugin registers no hooks', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(Object.keys(manifest)).not.toContain('hooks');
  });

  it('ships no hooks directory and no settings that could install one', () => {
    // A hooks folder or settings file is how a plugin runs without being asked.
    expect(existsSync(join(PLUGIN, 'hooks')), 'plugin/hooks/ exists').toBe(false);
    for (const f of ['settings.json', 'hooks.json']) {
      expect(existsSync(join(PLUGIN, f)), `plugin/${f} exists`).toBe(false);
    }
  });

  it('the command files invoke delulu directly, never via an event', () => {
    // Front matter that mentions hooks could arrange for the command to fire later.
    for (const f of ['handoff.md', 'resume.md']) {
      const text = readFileSync(join(PLUGIN, 'commands', f), 'utf8');
      const front = text.slice(0, text.indexOf('---', 3));
      expect(front, `${f} front matter mentions hooks`).not.toMatch(/hook/i);
    }
  });
});
