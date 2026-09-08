// The bundles this suite runs are not the bundles a user runs.
//
// The big suites are not naive about this: `handoff.test.ts` and `resume.test.ts` execute BUNDLED
// code, not `src/`. What they execute is a bundle they build themselves into a fresh temp
// directory at import time. So the source is covered, bundling is covered, and the two files
// actually shipped are covered by nothing at all.
//
// That is a narrower gap than "nobody tests the bundle" and a worse one, because the suite looks
// like it is testing the artifact and is not. A fresh clone gets whatever `plugin/hook/handoff.mjs`
// and `plugin/hook/resume.mjs` held on the day somebody last remembered to run `npm run build`.
//
// That gap was real and it was expensive. The bundles were last rebuilt at `da31901`. Two commits
// after it, `0a15d7c` and `2667811` raised the delivery budget from a remembered 23,000 bytes to a
// measured 27,000 and gave every block a share of it. Both were written, reviewed, tested and
// committed. Neither ever reached the running code. The session that discovered this opened by
// loading a 26,589-byte handoff that arrived TRIMMED, with three blocks missing, against a fix
// that had been sitting green in `src/` for two days and would have let it through whole.
//
// So this rebuilds both bundles into a temp directory and compares them byte for byte with what is
// committed. It does not write to `plugin/hook/`: a test that silently fixed the problem would hide it,
// and the point is to fail loudly enough that somebody runs the build and commits the result.
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP = resolve(__dirname, '..', '..');

/** Kept in step with `hook/build.mjs` by the first test below, not by hope. */
const ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['src/cli/handoff.ts', '../plugin/hook/handoff.mjs'],
  ['src/cli/resume.ts', '../plugin/hook/resume.mjs'],
];

// Must match `hook/build.mjs` exactly, `absWorkingDir` included: esbuild records module paths
// relative to the cwd, so without it this test's build and the real one differ by the
// directory each happened to run from, and the comparison reports staleness that isn't there.
const COMMON = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', absWorkingDir: APP } as const;

describe('the bundles a user actually runs match the source we test', () => {
  it('knows about every bundle the build script produces', () => {
    // Guarding the guard. A third entry added to `build.mjs` would otherwise ship unchecked for
    // ever, because this file would keep passing while testing two things out of three.
    const script = readFileSync(join(APP, 'hook', 'build.mjs'), 'utf8');
    const declared = [...script.matchAll(/\['([^']+\.ts)',\s*'([^']+\.mjs)'\]/g)].map((m) => [m[1], m[2]]);
    expect(declared.length, 'no entries found in build.mjs — has its shape changed?').toBeGreaterThan(0);
    expect(declared).toEqual(ENTRIES.map((e) => [...e]));
  });

  it.each(ENTRIES)('%s is committed at %s as it builds today', async (src, out) => {
    const dir = mkdtempSync(join(tmpdir(), 'delulu-shipped-'));
    try {
      const outfile = join(dir, 'built.mjs');
      await build({ ...COMMON, entryPoints: [join(APP, src)], outfile });
      const fresh = readFileSync(outfile, 'utf8');
      const committed = readFileSync(join(APP, out), 'utf8');
      // Byte equality, deliberately. A looser check would have to decide which differences are
      // cosmetic, and the difference that hurt here was a pair of integer constants.
      expect(fresh === committed,
        `${out} is stale: it does not match a fresh build of ${src}. Run \`npm run build\` in app/ and commit the result.`,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `plugin/bin/` holds the same command twice, once per platform. Nothing executes the Windows half
// here — there is no Windows machine in this suite, and a test that pretended otherwise would be
// the false green this file exists to prevent. So these are STRUCTURAL assertions, and they are
// deliberately limited to the three things that made the POSIX shim work: it resolves from its own
// location rather than the caller's, it forwards every argument, and it surfaces the child's exit
// code. Those are the properties whose absence turned `delulu` into a shell alias that existed on
// exactly one machine.
describe('plugin/bin — the same command on both platforms, or it is a lie on one of them', () => {
  const BIN = resolve(APP, '..', 'plugin', 'bin');
  const sh = readFileSync(join(BIN, 'delulu'), 'utf8');
  const cmd = readFileSync(join(BIN, 'delulu.cmd'), 'utf8');

  it('both resolve the dispatcher from their OWN location, never from the cwd', () => {
    // The plugin lives in a versioned cache directory whose path nobody can hardcode.
    expect(sh).toContain('dirname "$0"');
    expect(cmd).toContain('%~dp0..');
    for (const f of [sh, cmd]) expect(f).toContain('hook');
    for (const f of [sh, cmd]) expect(f).toContain('cli.mjs');
  });

  it('both forward every argument, not just the first', () => {
    // The exact failure just fixed in resume's parseArgs, one layer lower: a multi-word handoff
    // name reaching the shim and arriving as one word, or not arriving at all.
    expect(sh).toContain('"$@"');
    expect(cmd).toContain('%*');
  });

  it('the Windows shim calls node rather than handing control to it', () => {
    // Under nvm-windows or Volta, `node` on PATH is a node.cmd SHIM. A batch file that invokes
    // another batch file without `call` transfers control and never comes back, so `exit /b` never
    // runs. Nothing pinned this: the shim's own comment described the `call` for a while when there
    // was no `call` in the file, and removing it again would leave the suite green.
    expect(cmd).toMatch(/\bcall\s+node\b/);
  });

  it('both surface the dispatcher exit code instead of reporting success over a failure', () => {
    expect(sh).toContain('exec node');            // exec REPLACES the shell, so the code is the child's
    expect(cmd).toContain('exit /b %ERRORLEVEL%'); // cmd does not propagate it for you
  });

  it('neither hardcodes an absolute path or an author', () => {
    for (const f of [sh, cmd]) {
      expect(f).not.toMatch(/\/Users\/|C:\\\\|\/home\//);
      expect(f.toLowerCase()).not.toContain('karankumar');
    }
  });

  it('the POSIX shim has no CRLF — a `\\r` in the shebang reads as a broken install', () => {
    // .gitattributes pins this, and .gitattributes is exactly the kind of file that gets deleted
    // by someone tidying up. This is the assertion that notices.
    expect(sh).not.toContain('\r');
    expect(sh.startsWith('#!/bin/sh')).toBe(true);
  });
});

// `npm run build` used to be `build.mjs && sync-cache.mjs`, and sync-cache MIRRORS AND DELETES
// inside ~/.claude/plugins/cache/delulu/delulu/<version>/ — the contributor's real, installed
// plugin. The README's Development section tells a stranger that plugin/hook/*.mjs is generated and
// must be rebuilt, so the docs actively pointed them at a command that would overwrite and prune
// their working install from a throwaway clone, with no dry-run and no warning. Found by running
// the documented contributor path on a fresh copy as a stranger would.
//
// Syncing is the author's convenience and is now opt-in as `npm run dev` / `npm run sync`.
describe('npm run build — safe for a stranger with delulu installed', () => {
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

// The carried-rules block is not a comment — it is interpolated into the user's own payload.md.
// It carried one author's biography into everyone's document: "the user was being told, every
// session", "four were one sentence HE had repeated across three sessions", a verbatim quote from
// that author's session, and "since this block reached 29 lines". A stranger's second capture
// asserted all of it about them, in the third person, in a file written under delulu's name.
//
// This scans the SHIPPED bundle rather than the source, because the bundle is what a user runs and
// the source comments around it are allowed to say whatever they like. The pronoun rule is the
// durable half: a document addressed to "you" has no business referring to "he".
describe('the text written into a user document is about THEM, not about the author', () => {
  const bundle = readFileSync(resolve(APP, '../plugin/hook/handoff.mjs'), 'utf8');
  const carried = (() => {
    // Anchor on text from the TEMPLATE, not on the marker constant. The first version of this test
    // sliced from `indexOf('CARRIED FORWARD')`, which in the bundle is the constant's DEFINITION —
    // the template interpolates it — so the scan ran over the wrong 4KB and passed with the
    // biography fully present. Caught by reverting the fix and watching the test stay green.
    const start = bundle.indexOf('ASK ONE QUESTION OF EVERY LINE');
    expect(start).toBeGreaterThan(-1);        // a reword must fail loudly, not silently pass
    const end = bundle.indexOf('CANNOT BE EITHER', start);
    expect(end).toBeGreaterThan(start);
    return bundle.slice(start, end);
  })();

  it('carries no third-person account of what the author did in past sessions', () => {
    for (const fragment of [
      'repeated across three sessions',
      'was being told',
      'steer u right',
      'reached 29 lines',
    ]) expect(carried).not.toContain(fragment);
  });

  it('never refers to the reader, or anyone, as "he"', () => {
    expect(carried).not.toMatch(/\b(?:he|his|him)\b/i);
  });

  it('and neither do the command files, which are loaded into the model every session', () => {
    // The first version of this guard covered only the carried block, and a gendered claim about
    // the reader survived in handoff.md — "the next session copied it into HIS memory files" —
    // read into context on every single capture. A test that covers one of two reader-facing
    // surfaces is a test that says the problem is solved when it is half solved.
    for (const f of ['handoff.md', 'resume.md']) {
      const text = readFileSync(resolve(APP, '../plugin/commands', f), 'utf8');
      expect(text, f).not.toMatch(/\b(?:he|his|him)\b/i);
    }
  });
});

// `version` is deliberately ABSENT from plugin.json, and that is load-bearing enough to bind.
//
// Docs, verbatim: "Setting this pins the plugin to that version string, so users only receive
// updates when you bump it" and "For git-based sources, if you omit `version`, Claude Code uses the
// source's resolved commit SHA, so users get an update whenever that commit changes; this is the
// simplest setup for internal or actively developed plugins."
//
// delulu ships from a git source. With a pin, shipping a fix without bumping delivers it to NOBODY,
// silently, with nothing to tell you — the exact shape of failure this project keeps finding and
// removing. Without one, the version IS the commit, which also identifies a reporter's build more
// precisely than a hand-bumped string ever could.
//
// `claude plugin validate` WARNS about the absence and `--strict` fails on it. That warning is
// advice and it is wrong for this source type: measured on 2026-09-07 against the live
// anthropics/claude-plugins-community catalog, 0 of 2,282 approved plugins declare a version in
// their marketplace entry. Not a minority — none of them.
//
// This is a check rather than a comment because the field looks like an omission, and because a
// validator actively suggests adding it. Someone will.
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
