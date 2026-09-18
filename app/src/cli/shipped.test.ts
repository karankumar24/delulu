// The shipped plugin: bundles byte-equal to a fresh build, a build that never touches an install, and manifests that pin no version.
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP = resolve(__dirname, '..', '..');

/** Kept in step with `scripts/build.mjs` by the first test below, not by hope. */
const ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['src/cli/save.ts', '../plugin/hook/handoff.mjs'],
  ['src/cli/load.ts', '../plugin/hook/resume.mjs'],
];

// Must match scripts/build.mjs, absWorkingDir included: esbuild records module paths relative to it.
const COMMON = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', absWorkingDir: APP } as const;

describe('the bundles a user actually runs match the source we test', () => {
  it('knows about every bundle the build script produces', () => {
    // A third entry in build.mjs would otherwise ship unchecked.
    const script = readFileSync(join(APP, 'scripts', 'build.mjs'), 'utf8');
    const declared = [...script.matchAll(/\['([^']+\.ts)',\s*'([^']+\.mjs)'\]/g)].map((m) => [m[1], m[2]]);
    expect(declared.length, 'no entries found in build.mjs; has its shape changed?').toBeGreaterThan(0);
    expect(declared).toEqual(ENTRIES.map((e) => [...e]));
  });

  it.each(ENTRIES)('%s is committed at %s as it builds today', async (src, out) => {
    const dir = mkdtempSync(join(tmpdir(), 'delulu-shipped-'));
    try {
      const outfile = join(dir, 'built.mjs');
      await build({ ...COMMON, entryPoints: [join(APP, src)], outfile });
      const fresh = readFileSync(outfile, 'utf8');
      const committed = readFileSync(join(APP, out), 'utf8');
      // Byte equality: any difference means the committed bundle is stale.
      expect(fresh === committed,
        `${out} is stale: it does not match a fresh build of ${src}. Run \`npm run build\` in app/ and commit the result.`,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Syncing into the installed plugin cache is opt-in, so building a clone never overwrites a working install.
describe('npm run build: safe for a stranger with delulu installed', () => {
  const pkg = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8')) as
    { scripts: Record<string, string> };

  it('does not run sync-cache', () => {
    expect(pkg.scripts.build).not.toContain('sync-cache');
  });

  it('still builds both shipped bundles', () => {
    // Weakening the guard by emptying the script would pass the test above and break the build.
    expect(pkg.scripts.build).toContain('build.mjs');
  });

  it('keeps an explicit, opt-in way to sync', () => {
    const optIn = [pkg.scripts.sync, pkg.scripts.dev].filter(Boolean).join(' ');
    expect(optIn).toContain('sync-cache');
  });
});

// What delulu tells the next session has to hold for any user.
describe('what delulu tells the next session is about any user, not about its author', () => {
  it("tells the next session the user's messages are context, and only what was decided in that session holds", () => {
    const load = readFileSync(resolve(APP, 'src/cli/load.ts'), 'utf8');
    expect(load).toContain('are context for where things stood, not orders');
    expect(load).toContain('decided in that session holds');
  });

  it('asks the saving agent about this session only, and never for rules carried from earlier ones', () => {
    const prompt = readFileSync(resolve(APP, '../plugin/commands/handoff.md'), 'utf8');
    expect(prompt).toContain('Cover this session only');
    expect(prompt).not.toMatch(/standing rules|handoff this session loaded/i);
  });

  it('never tells the next session to open with a question to the user', () => {
    for (const f of ['src/cli/load.ts', '../plugin/commands/resume.md', '../plugin/commands/handoff.md'])
      expect(readFileSync(resolve(APP, f), 'utf8'), f).not.toContain('AskUserQuestion');
  });

  it('and the command files, loaded into the model every session, never call anyone "he"', () => {
    for (const f of ['handoff.md', 'resume.md']) {
      const text = readFileSync(resolve(APP, '../plugin/commands', f), 'utf8');
      expect(text, f).not.toMatch(/\b(?:he|his|him)\b/i);
    }
  });
});

describe('plugin.json declares no version, so a push IS the release', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(APP, '../plugin/.claude-plugin/plugin.json'), 'utf8')) as Record<string, unknown>;
  const marketplace = JSON.parse(
    readFileSync(resolve(APP, '../.claude-plugin/marketplace.json'), 'utf8')) as
    { plugins: Array<Record<string, unknown>> };

  it('the plugin manifest pins nothing', () => {
    expect(manifest).not.toHaveProperty('version');
  });

  it('nor does the marketplace entry, which pins just the same', () => {
    // Docs: "If set (here or in plugin.json), the plugin is pinned to this string."
    for (const entry of marketplace.plugins) expect(entry).not.toHaveProperty('version');
  });

  it('still declares the identity a cautious user checks before installing', () => {
    // Dropping version must not become an excuse to drop the fields that DO belong here.
    for (const k of ['name', 'description', 'license', 'repository', 'homepage']) {
      expect(manifest).toHaveProperty(k);
    }
  });
});
