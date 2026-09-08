// The 2026-08-15 incident, bound. A test one-liner imported `hook/handoff.mjs` to reach a symbol
// and the import performed a full capture against the real repo, writing a handoff folder for a
// session nobody ever had — which a later payload then described as an interview "never finished".
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const APP = process.cwd();
const OUT = mkdtempSync(join(tmpdir(), 'delulu-entry-'));
const HANDOFF = join(OUT, 'handoff.mjs');
const RESUME = join(OUT, 'resume.mjs');
beforeAll(async () => {
  for (const [src, outfile] of [['src/cli/handoff.ts', HANDOFF], ['src/cli/resume.ts', RESUME]] as const) {
    await build({ bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      entryPoints: [resolve(APP, src)], outfile });
  }
});
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

const CLEAN_ENV = (() => { const e = { ...process.env }; delete e.CLAUDE_CODE_SESSION_ID; return e; })();
let repo: string | null = null;
afterEach(() => { if (repo) { rmSync(repo, { recursive: true, force: true }); repo = null; } });

/**
 * A git identity supplied by the TEST, never inherited from the machine.
 *
 * `git commit` with no identity fails `fatal: empty ident name ... not allowed`. On a developer's
 * laptop a global `user.email` hides that; on a fresh CI runner, or a new contributor's machine,
 * nothing does. This suite passed locally for months and failed on its very first CI run, on a
 * repository whose one visible quality signal is that CI badge. A test that reads the developer's
 * own configuration is testing the developer.
 */
const GIT_ID = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

/** A real git repo, so an unguarded capture would genuinely have somewhere to write. */
function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'delulu-entryrepo-'));
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: GIT_ID });
  return d;
}

describe('entry — importing a command must never RUN it', () => {
  it('writes nothing when handoff.mjs is imported via node -e', () => {
    repo = gitRepo();
    // Exactly the shape that caused it: `node -e` leaves process.argv[1] undefined, which is why
    // "no entry path" has to mean NOT-the-program rather than degrade-open.
    execFileSync('node', ['-e', `import(${JSON.stringify(pathToFileURL(HANDOFF).href)}).catch(() => {})`],
      { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
    expect(existsSync(join(repo, '.delulu-handoff'))).toBe(false);
  });

  it('writes nothing when resume.mjs is imported — importing it also MUTATES', () => {
    repo = gitRepo();
    const out = execFileSync('node', ['-e', `import(${JSON.stringify(pathToFileURL(RESUME).href)}).catch(() => {})`],
      { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
    expect(out).toBe('');
    expect(existsSync(join(repo, '.delulu-handoff'))).toBe(false);
  });

  it('STILL RUNS when invoked as a program — the guard must not silence the CLI', () => {
    repo = gitRepo();
    // The failure mode worse than the bug: a guard that decides "imported" for a real invocation
    // makes delulu a silent no-op, which is what lets an agent conclude it worked.
    execFileSync('node', [HANDOFF, '--repo', repo, '--log', resolve(APP, 'fixtures/iyw-session.jsonl')],
      { env: CLEAN_ENV, encoding: 'utf8' });
    const folders = readdirSync(join(repo, '.delulu-handoff')).filter((f) => f !== 'PENDING');
    expect(folders).toHaveLength(1);
  });
});
