// What "everything reads natural and humanized" can be held to by a TEST rather than by a rule.
//
// It was carried as a standing rule for sessions — a sentence asking each new agent to remember
// something. Most of it cannot be anything else: whether a sentence nobody has written yet reads
// like a person is a judgement, and no assertion reaches it. But part of it is mechanical, and the
// mechanical part had been restated instead of enforced. `commands/resume.md` still shipped
// `argument-hint: "[--list | <name>]"` on the day this file was written, months after the user
// first objected to it — which is what a rule looks like when it lives in prose.
//
// So these are the halves a test can actually catch: CLI-grammar where a sentence belongs, a
// folder stamp reaching somebody's eyes, and a heading shouting in capitals. Each one failed in
// the field at least once. What is left over stays prose, and is much shorter for it.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { SECTION } from './payload';

const REPO = resolve(process.cwd(), '..');
// Everything a user installs lives under `plugin/` — the marketplace ships that subtree alone
// (`source: ./plugin`), so these are the files a stranger actually reads.
const COMMANDS = join(REPO, 'plugin', 'commands');
const commandFiles = readdirSync(COMMANDS).filter((f) => f.endsWith('.md'));

/** The value of one YAML front-matter key, or undefined when the key is absent. */
function frontMatter(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, 'm'));
  return m ? m[1] : undefined;
}

describe('the slash-command surface reads like language, not like a man page', () => {
  it('finds the command files at all', () => {
    // Guarding the guard: if this directory moves, every assertion below passes by finding nothing,
    // and a check that cannot fail is worse than no check because it reports success.
    expect(commandFiles.length).toBeGreaterThan(0);
  });

  it.each(commandFiles)('%s — its hint has no CLI grammar in it', (file) => {
    const hint = frontMatter(readFileSync(join(COMMANDS, file), 'utf8'), 'argument-hint');
    if (hint === undefined) return;    // absence is a separate test, below
    // `[--list | <name>]` is the shape this rejects: square brackets for optional, angle brackets
    // for a placeholder, a pipe for alternation. It is precise, it is conventional, and it is
    // unreadable to somebody who just wants to know what to type.
    expect(hint, `${file} hint reads as syntax: ${hint}`).not.toMatch(/[[\]<>|]/);
  });

  it.each(commandFiles)('%s — says what happens with no argument', (file) => {
    const hint = frontMatter(readFileSync(join(COMMANDS, file), 'utf8'), 'argument-hint');
    // A command with no hint tells the reader nothing about whether it wants an argument. Both of
    // delulu's run fine with none, and saying so is the single most useful thing a hint can do.
    expect(hint, `${file} has no argument-hint`).toBeDefined();
    expect(hint!.length).toBeGreaterThan(0);
  });

  it.each(commandFiles)('%s — its description is a sentence, not a shout', (file) => {
    const desc = frontMatter(readFileSync(join(COMMANDS, file), 'utf8'), 'description') ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(shoutedWords(desc), `${file} description shouts: ${desc}`).toEqual([]);
  });

  // The dash rule is deliberately NOT applied to the bodies of these files, which are full of them.
  // It applies to the two strings a person reads in the slash menu with no surrounding context, and
  // where "a phrase, an em dash, a restatement of the phrase" is the single most recognisable tell
  // that nobody wrote the sentence. A comma or a full stop says the same thing and sounds like
  // somebody talking. Punctuation only: whether the WORDS sound generated is a judgement, and a
  // vocabulary blacklist would accuse honest sentences, which is how this repo has failed before.
  it.each(commandFiles)('%s — its menu strings use no em or en dash', (file) => {
    const text = readFileSync(join(COMMANDS, file), 'utf8');
    for (const key of ['description', 'argument-hint']) {
      const value = frontMatter(text, key);
      if (value === undefined) continue;
      expect(DASH.test(value), `${file} ${key} has a dash in it: ${value}`).toBe(false);
    }
  });

  it('would notice a dash if one came back', () => {
    // The positive control, for the same reason as the stamp's below: a pattern that matches
    // nothing turns every assertion above into a permanent pass.
    expect(DASH.test('nothing needed — it captures the session you are in')).toBe(true);
    expect(DASH.test('leave it empty for your latest, or name one, or say list')).toBe(false);
  });
});

/** An em or en dash. A hyphen is fine; `argument-hint` is itself hyphenated. */
const DASH = /[\u2013\u2014]/;

// The plugin manifests are read BEFORE anything in `commands/`. Somebody browsing a marketplace
// meets these two strings and nothing else, and both shipped with the same appositive dash the
// command hints had. Whatever standard the slash menu is held to, the storefront is held to first.
describe('the plugin manifests read like the slash menu does', () => {
  // The marketplace manifest stays at the clone root; the plugin manifest moved with the plugin.
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

  it.each(MANIFESTS)('%s — is there and describes itself', (file) => {
    // The same guard the command files get: a manifest that moved would otherwise make every
    // assertion below pass by finding nothing to assert about.
    const found = descriptions(JSON.parse(readFileSync(join(REPO, file), 'utf8')));
    expect(found.length, `${file} has no description at all`).toBeGreaterThan(0);
    for (const d of found) expect(d.trim().length).toBeGreaterThan(0);
  });

  it.each(MANIFESTS)('%s — no em or en dash, and no shouting', (file) => {
    for (const d of descriptions(JSON.parse(readFileSync(join(REPO, file), 'utf8')))) {
      expect(DASH.test(d), `${file} description has a dash in it: ${d}`).toBe(false);
      expect(shoutedWords(d), `${file} description shouts: ${d}`).toEqual([]);
    }
  });
});

/** Words of three or more letters in all capitals — the shape of a shouted label. */
function shoutedWords(text: string): string[] {
  // Acronyms are not shouting and never were. The list is short and specific on purpose: a general
  // "allow any acronym" rule would let a shouted label through the moment somebody abbreviated it.
  const allowed = new Set(['CLI', 'API', 'JSON', 'YAML', 'URL', 'MCP', 'AI', 'ID', 'OK', 'KB', 'MB']);
  return [...text.matchAll(/\b[A-Z]{3,}\b/g)].map((m) => m[0]).filter((w) => !allowed.has(w));
}

describe('the payload speaks to a person', () => {
  const headings = Object.values(SECTION);

  it('has no shouted section headings left', () => {
    // These were `## STATE`, `## IN YOUR WORDS`, `## THE AGENT'S READ` — labels a reader had to
    // decode before they could read anything. They are sentences now, and this is what stops one
    // creeping back the next time a section is added in a hurry.
    for (const h of headings) expect(shoutedWords(h), `heading shouts: ${h}`).toEqual([]);
  });

  it('names every section in words a reader would use out loud', () => {
    // A heading is a phrase, not an identifier: no snake_case, no camelCase, no leading dashes.
    for (const h of headings) expect(h, `heading is not prose: ${h}`).toMatch(/^[A-Z][A-Za-z ,'()—-]*$/);
  });
});

describe('the folder stamp never reaches somebody`s eyes', () => {
  /** `2026-08-29T04-17-37`, optionally with the same-second `-2` suffix. */
  const STAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\b/;

  it.each(commandFiles)('%s — carries no stamp in its front matter', (file) => {
    // The rule the user gave for this is blunt — a stamp printed to a human "looks badd so baddd".
    // It is a filesystem key, and every place it surfaces is a place delulu forgot who was reading.
    const text = readFileSync(join(COMMANDS, file), 'utf8');
    const front = text.slice(0, text.indexOf('---', 3));
    expect(STAMP.test(front), `${file} front matter carries a stamp`).toBe(false);
  });

  it('is still recognisable as a stamp, so this test can fail', () => {
    // The positive control. Without it a broken pattern makes every assertion above pass silently,
    // which is the exact failure mode this repo has shipped before.
    expect(STAMP.test('2026-08-29T04-17-37')).toBe(true);
    expect(STAMP.test('2026-08-29T04-17-37-2')).toBe(true);
    expect(STAMP.test('an ordinary sentence about Tuesday')).toBe(false);
  });
});

// The em-dash, held by a test instead of by a sentence in a handoff.
//
// It was asked for twice, in the user's own words the second time, and the first pass missed it
// because the dash was not only prose: two functions recovered a section by splitting its heading
// on ' — ', and one string nobody grepped went on printing one after every other had been fixed.
// A rule restated more than once is a rule that should have become a check, so here it is.
//
// This runs the REAL CLI over a REAL capture and resume rather than reading source, because that
// last surviving dash was in a template literal that static analysis had already cleared. What a
// user sees is the only thing worth asserting on.
//
// Two dashes are deliberately allowed, and neither reaches a user: the parser patterns that still
// ACCEPT an em-dash so a handoff sealed by the older version keeps loading. Those are matched, not
// written, and the day they are removed every sealed handoff on disk stops being read.
describe('nothing delulu prints carries an em-dash', () => {
  const OUT = mkdtempSync(join(tmpdir(), 'delulu-voice-'));
  const CLI = { handoff: join(OUT, 'handoff.mjs'), resume: join(OUT, 'resume.mjs') };
  let printed = '';

  beforeAll(async () => {
    const common = { bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node22', logLevel: 'silent' as const };
    await build({ ...common, entryPoints: [resolve(REPO, 'app/src/cli/handoff.ts')], outfile: CLI.handoff });
    await build({ ...common, entryPoints: [resolve(REPO, 'app/src/cli/resume.ts')], outfile: CLI.resume });

    const repo = mkdtempSync(join(tmpdir(), 'delulu-voice-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.co', 'commit', '-qm', 'init'], { cwd: repo });

    const log = join(repo, 'session.jsonl');
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
    // Capture, then read back: the notice, the draft on disk, and every resume path including the
    // ones that only print when something is wrong.
    printed = [
      run(CLI.handoff, ['--repo', repo, '--log', log]),
      run(CLI.resume, ['--repo', repo]),
      run(CLI.resume, ['--repo', repo, '--list']),
      run(CLI.resume, ['--repo', repo, 'no-such-handoff']),
      run(CLI.handoff, ['--repo', repo, '--log', join(repo, 'missing.jsonl')]),
      readdirSync(join(repo, '.delulu-handoff'))
        .filter((d) => d !== 'PENDING')
        .map((d) => readFileSync(join(repo, '.delulu-handoff', d, 'payload.md'), 'utf8'))
        .join('\n'),
    ].join('\n');
  });

  it('captured enough output to be worth asserting on', () => {
    // Guarding the guard: an empty string contains no em-dash and would pass every check below.
    expect(printed.length).toBeGreaterThan(2000);
    expect(printed).toContain(SECTION.said);
  });

  it('prints none, across capture, resume, the draft and the error paths', () => {
    const lines = printed.split('\n').filter((l) => l.includes('\u2014'));
    expect(lines, `em-dash reached the user:\n${lines.slice(0, 5).join('\n')}`).toEqual([]);
  });

  it('would notice one, so this test can fail', () => {
    // The positive control, in the same spirit as the stamp test above.
    expect('delulu resume — loading'.split('\n').filter((l) => l.includes('\u2014'))).toHaveLength(1);
  });
});
