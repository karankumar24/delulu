// sync-cache mirrors the repo into the INSTALLED plugin cache, which is what a fresh Claude Code
// session actually runs. It only ever COPIED, so a file deleted or renamed in the repo kept running
// from the cache forever while the build reported success — a renamed slash command would leave
// both installed, the old one still working and pointing at stale behaviour.
//
// It is a delete path, and delulu's other delete path shipped a defect that destroyed the newest
// handoffs, so the guards are the subject here as much as the mirroring.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const APP = process.cwd();
const SYNC = resolve(APP, 'hook/sync-cache.mjs');
let home: string | null = null;
afterEach(() => { if (home) { rmSync(home, { recursive: true, force: true }); home = null; } });

/** A fake HOME with one installed cache version, so the real plugin install is never touched. */
function fakeCache(seed: Record<string, string[]>): string {
  home = mkdtempSync(join(tmpdir(), 'delulu-cache-'));
  const base = join(home, '.claude/plugins/cache/delulu/delulu/0.1.0');
  for (const [rel, files] of Object.entries(seed)) {
    mkdirSync(join(base, rel), { recursive: true });
    for (const f of files) writeFileSync(join(base, rel, f), 'stale');
  }
  return base;
}

// CLAUDE_CONFIG_DIR is deleted, not merely overridden: the script now honours it, so a developer
// or CI runner with the variable exported would send every one of these tests at THEIR real
// config directory instead of the fake HOME. The env a test runs under must not decide what it
// asserts about.
const baseEnv = () => { const e = { ...process.env }; delete e.CLAUDE_CONFIG_DIR; return e; };
const run = (h: string) => spawnSync('node', [SYNC], { encoding: 'utf8', env: { ...baseEnv(), HOME: h } });

describe('sync-cache — mirror, not copy-and-hope', () => {
  it('removes a cached file the repo no longer has, and says which', () => {
    const base = fakeCache({ hook: ['OLD-RENAMED.mjs'], commands: ['old-command.md'] });
    const r = run(home!);
    expect(existsSync(join(base, 'hook/OLD-RENAMED.mjs'))).toBe(false);
    expect(existsSync(join(base, 'commands/old-command.md'))).toBe(false);
    expect(r.stdout).toMatch(/removed 2 stale file\(s\)/);
    expect(r.stdout).toContain('OLD-RENAMED.mjs');   // never a silent delete
  });

  it('copies the current files in', () => {
    const base = fakeCache({ hook: [], commands: [] });
    run(home!);
    expect(readdirSync(join(base, 'hook'))).toContain('cli.mjs');
    expect(readdirSync(join(base, 'commands'))).toContain('handoff.md');
  });

  it('leaves a file it does not manage alone', () => {
    const base = fakeCache({ commands: ['NOTES.txt'] });
    run(home!);
    expect(existsSync(join(base, 'commands/NOTES.txt'))).toBe(true);
  });

  it('deletes NOTHING when the source listing is empty — an empty source is a wrong path, not an order to wipe', () => {
    // The script locates the repo RELATIVE TO ITSELF, so a real copy of it is placed in a repo
    // whose commands/ directory is genuinely empty. Without the guard, every cached .md looks
    // orphaned and the install is wiped — the blast radius prune actually shipped.
    home = mkdtempSync(join(tmpdir(), 'delulu-cache-'));
    const base = join(home, '.claude/plugins/cache/delulu/delulu/0.1.0');
    mkdirSync(join(base, 'commands'), { recursive: true });
    writeFileSync(join(base, 'commands/handoff.md'), 'stale');
    const empty = mkdtempSync(join(tmpdir(), 'delulu-emptyrepo-'));
    mkdirSync(join(empty, 'app/hook'), { recursive: true });        // where the script itself sits
    mkdirSync(join(empty, 'plugin/commands'), { recursive: true });  // exists, but has no .md in it
    const script = join(empty, 'app/hook/sync-cache.mjs');
    writeFileSync(script, readFileSync(SYNC, 'utf8'));
    const r = spawnSync('node', [script], { encoding: 'utf8', env: { ...baseEnv(), HOME: home } });
    expect(r.status).toBe(0);                                     // it really ran
    expect(r.stdout).not.toMatch(/removed/);
    expect(existsSync(join(base, 'commands/handoff.md'))).toBe(true);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('sync-cache — a relocated config dir', () => {
  // The shipped runtime has honoured CLAUDE_CONFIG_DIR since the hardcoded `~/.claude` was found
  // to make delulu blind for anyone who relocates their config. This script did NOT, so on such a
  // machine it looked in a directory with no cache, took the no-op branch, and printed
  // "no delulu plugin cache installed — skipped." A developer there would edit source, build,
  // see success, and run stale code forever with nothing to tell them why.
  it('mirrors into $CLAUDE_CONFIG_DIR, not ~/.claude', () => {
    home = mkdtempSync(join(tmpdir(), 'delulu-cache-'));
    const cfg = join(home, 'elsewhere');
    const base = join(cfg, 'plugins/cache/delulu/delulu/0.1.0');
    mkdirSync(join(base, 'hook'), { recursive: true });
    mkdirSync(join(base, 'commands'), { recursive: true });
    // A real HOME that holds NO cache at all, so a pass cannot come from the old code path.
    const r = spawnSync('node', [SYNC], {
      encoding: 'utf8',
      env: { ...process.env, HOME: join(home, 'home'), CLAUDE_CONFIG_DIR: cfg },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/no delulu plugin cache installed/);
    expect(readdirSync(join(base, 'hook'))).toContain('cli.mjs');
    expect(readdirSync(join(base, 'commands'))).toContain('handoff.md');
  });

  it('treats a whitespace-only value as unset, matching the runtime', () => {
    const base = fakeCache({ hook: [], commands: [] });
    const r = spawnSync('node', [SYNC], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home!, CLAUDE_CONFIG_DIR: '   ' },
    });
    expect(r.status).toBe(0);
    expect(readdirSync(join(base, 'hook'))).toContain('cli.mjs');
  });
});
