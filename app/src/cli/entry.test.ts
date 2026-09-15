// Importing a bundled command must never run it; running it must.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const APP = process.cwd();
const OUT = mkdtempSync(join(tmpdir(), 'delulu-entry-'));
const HANDOFF = join(OUT, 'handoff.mjs');
const RESUME = join(OUT, 'resume.mjs');
beforeAll(async () => {
  for (const [src, outfile] of [['src/cli/save.ts', HANDOFF], ['src/cli/load.ts', RESUME]] as const) {
    await build({ bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      entryPoints: [resolve(APP, src)], outfile });
  }
});
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

const CLEAN_ENV = (() => { const e = { ...process.env }; delete e.CLAUDE_CODE_SESSION_ID; return e; })();
let repo: string | null = null;
afterEach(() => { if (repo) { rmSync(repo, { recursive: true, force: true }); repo = null; } });

/** A git identity from the test, so commits work on a machine with none configured. */
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

describe('entry: importing a command never runs it', () => {
  it('writes nothing when handoff.mjs is imported via node -e', () => {
    repo = gitRepo();
    // `node -e` leaves process.argv[1] undefined.
    execFileSync('node', ['-e', `import(${JSON.stringify(pathToFileURL(HANDOFF).href)}).catch(() => {})`],
      { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
    expect(existsSync(join(repo, '.delulu-handoff'))).toBe(false);
  });

  it('prints and writes nothing when resume.mjs is imported', () => {
    repo = gitRepo();
    const out = execFileSync('node', ['-e', `import(${JSON.stringify(pathToFileURL(RESUME).href)}).catch(() => {})`],
      { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
    expect(out).toBe('');
    expect(existsSync(join(repo, '.delulu-handoff'))).toBe(false);
  });

  it('still runs when invoked as a program', () => {
    repo = gitRepo();
    const log = join(OUT, 'session.jsonl');
    writeFileSync(log, '{"type":"user","message":{"role":"user","content":"fix the footer"}}\n');
    execFileSync('node', [HANDOFF, '--repo', repo, '--log', log], { env: CLEAN_ENV, encoding: 'utf8' });
    expect(readdirSync(join(repo, '.delulu-handoff'))).toHaveLength(1);
  });
});
