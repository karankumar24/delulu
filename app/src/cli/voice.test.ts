// The parts of plain wording a test can hold: no CLI grammar, dashes or shouting where a person reads
// delulu, and no folder stamps.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { renderHandoff } from './write';

const REPO = resolve(process.cwd(), '..');
// Everything a user installs lives under plugin/.
const COMMANDS = join(REPO, 'plugin', 'commands');
const commandFiles = readdirSync(COMMANDS).filter((f) => f.endsWith('.md'));

/** The value of one YAML front-matter key, or undefined when the key is absent. */
function frontMatter(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm'));
  return m ? m[1] : undefined;
}

describe('the slash-command surface reads like language, not like a man page', () => {
  it('finds the command files at all', () => {
    // Guarding the guard: if this folder moves, every check below passes on nothing.
    expect(commandFiles.length).toBeGreaterThan(0);
  });

  it.each(commandFiles)('%s: its hint has no CLI grammar in it', (file) => {
    const hint = frontMatter(readFileSync(join(COMMANDS, file), 'utf8'), 'argument-hint');
    if (hint === undefined) return;    // absence is a separate test, below
    // Brackets, angle brackets and pipes read as syntax, not as what to type.
    expect(hint, `${file} hint reads as syntax: ${hint}`).not.toMatch(/[[\]<>|]/);
  });

  it.each(commandFiles)('%s: has an argument hint', (file) => {
    const hint = frontMatter(readFileSync(join(COMMANDS, file), 'utf8'), 'argument-hint');
    expect(hint, `${file} has no argument-hint`).toBeDefined();
    expect(hint!.length).toBeGreaterThan(0);
  });

  it.each(commandFiles)('%s: its description does not shout', (file) => {
    const desc = frontMatter(readFileSync(join(COMMANDS, file), 'utf8'), 'description') ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(shoutedWords(desc), `${file} description shouts: ${desc}`).toEqual([]);
  });

  // Menu strings are read with no surrounding context.
  it.each(commandFiles)('%s: its menu strings use no em or en dash', (file) => {
    const text = readFileSync(join(COMMANDS, file), 'utf8');
    for (const key of ['description', 'argument-hint']) {
      const value = frontMatter(text, key);
      if (value === undefined) continue;
      expect(DASH.test(value), `${file} ${key} has a dash in it: ${value}`).toBe(false);
    }
  });

  it('would notice a dash if one came back', () => {
    // The positive control: a pattern that matches nothing would pass everything above.
    expect(DASH.test('nothing needed — it captures the session you are in')).toBe(true);
    expect(DASH.test('leave it empty for your latest, or name one, or say list')).toBe(false);
  });
});

/** An em or en dash. A hyphen is fine; `argument-hint` is itself hyphenated. */
const DASH = /[\u2013\u2014]/;

// The plugin manifests are the first strings someone browsing a marketplace reads.
describe('the plugin manifests read like the slash menu does', () => {
  const MANIFESTS = ['plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];

  /** Every `description` anywhere in the manifest, including the nested plugin entries. */
  function descriptions(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(descriptions);
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        k === 'description' && typeof v === 'string' ? [v] : descriptions(v));
    }
    return [];
  }

  it.each(MANIFESTS)('%s: is there and describes itself', (file) => {
    const found = descriptions(JSON.parse(readFileSync(join(REPO, file), 'utf8')));
    expect(found.length, `${file} has no description at all`).toBeGreaterThan(0);
    for (const d of found) expect(d.trim().length).toBeGreaterThan(0);
  });

  it.each(MANIFESTS)('%s: no em or en dash, and no shouting', (file) => {
    for (const d of descriptions(JSON.parse(readFileSync(join(REPO, file), 'utf8')))) {
      expect(DASH.test(d), `${file} description has a dash in it: ${d}`).toBe(false);
      expect(shoutedWords(d), `${file} description shouts: ${d}`).toEqual([]);
    }
  });
});

/** Words of three or more letters in all capitals. */
function shoutedWords(text: string): string[] {
  // Acronyms are not shouting. The list stays short, so an abbreviated label cannot slip through.
  const allowed = new Set(['CLI', 'API', 'JSON', 'YAML', 'URL', 'MCP', 'AI', 'ID', 'OK', 'KB', 'MB']);
  return [...text.matchAll(/\b[A-Z]{3,}\b/g)].map((m) => m[0]).filter((w) => !allowed.has(w));
}

describe('the handoff speaks to a person', () => {
  const out = renderHandoff({ project: 'p', savedAt: new Date(2026, 0, 1), transcript: 't.jsonl', folder: 'F', rules: ['- a rule'], note: 'n',
    redact: (t) => t, repo: { branch: 'main', commit: 'abc1234', uncommitted: 0, commits: [] },
    ex: { turns: [{ kind: 'said', line: 1, text: 'hi', how: 'typed' }], notices: [], unplaced: [], unreadable: [], replies: [{ line: 2, text: 'ok' }],
      helpers: [{ kind: 'agent', line: 3, what: 'x', ended: 'finished' }], saves: [], scheduled: [], prs: [] } });
  const headings = out.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

  it('writes every part it has', () => {
    expect(headings.length).toBeGreaterThanOrEqual(6);
  });

  it('has no shouted headings', () => {
    for (const h of headings) expect(shoutedWords(h), `heading shouts: ${h}`).toEqual([]);
  });

  it('names every part in words a reader would use out loud', () => {
    for (const h of headings) expect(h, `heading is not prose: ${h}`).toMatch(/^[A-Z][A-Za-z ,'()-]*$/);
  });
});

describe('the folder stamp never reaches somebody`s eyes', () => {
  /** `2026-08-29T04-17-37`, optionally with the same-second `-2` suffix. */
  const STAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\b/;

  it.each(commandFiles)('%s: carries no stamp in its front matter', (file) => {
    const text = readFileSync(join(COMMANDS, file), 'utf8');
    const front = text.slice(0, text.indexOf('---', 3));
    expect(STAMP.test(front), `${file} front matter carries a stamp`).toBe(false);
  });

  it('is still recognisable as a stamp, so this test can fail', () => {
    // The positive control.
    expect(STAMP.test('2026-08-29T04-17-37')).toBe(true);
    expect(STAMP.test('2026-08-29T04-17-37-2')).toBe(true);
    expect(STAMP.test('an ordinary sentence about Tuesday')).toBe(false);
  });
});

// Runs the real commands over a real save and resume: what a user sees is what is worth asserting on.
describe('nothing delulu prints carries an em-dash', () => {
  const OUT = mkdtempSync(join(tmpdir(), 'delulu-voice-'));
  const CLI = { handoff: join(OUT, 'handoff.mjs'), resume: join(OUT, 'resume.mjs') };
  let printed = '';

  beforeAll(async () => {
    const common = { bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node22', logLevel: 'silent' as const };
    await build({ ...common, entryPoints: [resolve(REPO, 'app/src/cli/save.ts')], outfile: CLI.handoff });
    await build({ ...common, entryPoints: [resolve(REPO, 'app/src/cli/load.ts')], outfile: CLI.resume });

    const repo = mkdtempSync(join(tmpdir(), 'delulu-voice-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.co', 'commit', '-qm', 'init'], { cwd: repo });

    const log = join(mkdtempSync(join(tmpdir(), 'delulu-voice-log-')), 'session.jsonl');
    writeFileSync(log, [
      '{"type":"user","message":{"role":"user","content":"keep the parser exactly as we discussed"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Holding it."}]}}',
      '{"type":"user","message":{"role":"user","content":"and never ship on a friday"}}',
    ].join('\n') + '\n');

    const env = (() => { const e = { ...process.env }; delete e.CLAUDE_CODE_SESSION_ID; return e; })();
    const run = (bin: string, args: string[]): string => {
      const r = spawnSync('node', [bin, ...args], { encoding: 'utf8', env });
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    };
    printed = [
      run(CLI.handoff, ['--repo', repo, '--log', log]),
      run(CLI.resume, ['--repo', repo]),
      run(CLI.resume, ['--repo', repo, '--list']),
      run(CLI.resume, ['--repo', repo, 'carry', 'on', 'with', 'the', 'parser']),
      run(CLI.handoff, ['--repo', repo, '--log', join(repo, 'missing.jsonl')]),
      readdirSync(join(repo, '.delulu-handoff')).filter((d) => /^\d{4}-/.test(d))
        .map((d) => readFileSync(join(repo, '.delulu-handoff', d, 'handoff.md'), 'utf8')).join('\n'),
    ].join('\n');
  }, 60_000);

  it('captured enough output to be worth asserting on', () => {
    expect(printed.length).toBeGreaterThan(1500);
    expect(printed).toContain("## The user's messages, newest first");
    expect(printed).toContain('How to carry on:');
    expect(printed).toContain('When resuming, the user added');
  });

  it('prints none, across capture, resume and the error paths', () => {
    const lines = printed.split('\n').filter((l) => l.includes('\u2014'));
    expect(lines, `em-dash reached the user:\n${lines.slice(0, 5).join('\n')}`).toEqual([]);
  });

  it('would notice one, so this test can fail', () => {
    // The positive control, in the same spirit as the stamp test above.
    expect('delulu resume — loading'.split('\n').filter((l) => l.includes('\u2014'))).toHaveLength(1);
  });
});

describe('the docs carry no em or en dash', () => {
  const walk = (dir: string): string[] => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.md') ? [join(dir, d.name)] : []);
  const DOCS = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', ...walk('docs'), ...walk('.github')];

  it('finds the docs', () => {
    expect(DOCS.length).toBeGreaterThan(5);
  });

  it.each(DOCS)('%s', (file) => {
    const found = readFileSync(join(REPO, file), 'utf8').split('\n').flatMap((l, k) => (DASH.test(l) ? [`${k + 1}: ${l}`] : []));
    expect(found, `${file} has a dash`).toEqual([]);
  });
});
