// delulu — transcript resolution unit tests.
//
// Regression cover for the audit's second root cause: Claude Code slugifies a repo path
// by replacing EVERY non-alphanumeric character with '-', not just slashes. The old
// slashes-only rule missed every repo path containing a space or a dot, `resolveLog`
// returned null, and `handoff` then declined silently while the agent hand-wrote the
// payload under delulu's letterhead.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectSlugs, resolveLog, projectsDir, claudeHome } from './resolve-log';

describe('projectSlugs', () => {
  it('matches Claude Code’s slug for a path containing spaces', () => {
    expect(projectSlugs('/Users/k/untitled folder 2')[0]).toBe('-Users-k-untitled-folder-2');
  });

  it('matches Claude Code’s slug for a worktree path containing a dot', () => {
    expect(projectSlugs('/Users/k/SomeProject/.claude-worktrees/ai-x')[0]).toBe(
      '-Users-k-SomeProject--claude-worktrees-ai-x',
    );
  });

  it('is unchanged for plain alphanumeric paths, and offers no redundant fallback', () => {
    expect(projectSlugs('/Users/k/Downloads/delulu')).toEqual(['-Users-k-Downloads-delulu']);
  });

  it('keeps the legacy slashes-only slug as a fallback candidate', () => {
    expect(projectSlugs('/Users/k/untitled folder 2')).toEqual([
      '-Users-k-untitled-folder-2',
      '-Users-k-untitled folder 2',
    ]);
  });
});

// Picking the wrong transcript is the one failure that fabricates the user's voice: it prints
// ANOTHER conversation's messages under "everything you said this session, verbatim". Reproduced on
// the author's machine — running from `<repo>/app` resolved a directory of 8 unrelated transcripts.
describe('resolveLog — identity beats guessing', () => {
  let home: string;
  const projects = () => join(home, '.claude', 'projects');
  const write = (slug: string, name: string, body = '{}') => {
    mkdirSync(join(projects(), slug), { recursive: true });
    writeFileSync(join(projects(), slug, name), body);
    return join(projects(), slug, name);
  };

  // os.homedir() honours $HOME on POSIX, so pointing it at a temp dir exercises the REAL code
  // path — no module mocking, and the test still fails if resolveLog stops consulting homedir().
  let realHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'delulu-home-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    rmSync(home, { recursive: true, force: true });
  });

  it('uses the session id when the harness provides one, ignoring mtime entirely', () => {
    const mine = write('-repo', '11111111-1111-1111-1111-111111111111.jsonl');
    const theirs = write('-repo', '22222222-2222-2222-2222-222222222222.jsonl');
    utimesSync(theirs, new Date(), new Date()); // the other window wrote last
    process.env.CLAUDE_CODE_SESSION_ID = '11111111-1111-1111-1111-111111111111';
    expect(resolveLog('/repo', '/repo')).toBe(mine);
  });

  it('finds it even when the slug rules would never look in that directory (worktree case)', () => {
    const mine = write('-Users-someone-original-project', '33333333-3333-3333-3333-333333333333.jsonl');
    process.env.CLAUDE_CODE_SESSION_ID = '33333333-3333-3333-3333-333333333333';
    expect(resolveLog('/Users/someone/original-project/.claude/worktrees/wt')).toBe(mine);
  });

  it('falls back to the old behaviour when no session id is exported', () => {
    const only = write('-repo', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    expect(resolveLog('/repo', '/repo')).toBe(only);
  });

  it('one unreadable file does not surrender the whole directory to another project', () => {
    const good = write('-repo-app', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    write('-repo', 'cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl'); // the WRONG project
    symlinkSync(join(projects(), '-repo-app', 'nope.jsonl'), join(projects(), '-repo-app', 'dangling.jsonl'));
    expect(resolveLog('/repo', '/repo/app')).toBe(good);
  });

  it('a long path still resolves — the slug is truncated and hashed like the harness does', () => {
    const deep = '/Users/someone/' + 'very-long-segment/'.repeat(14) + 'pkg';
    const slug = projectSlugs(deep)[0];
    expect(slug.length).toBeLessThanOrEqual(232);
    const mine = write(slug, 'dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl');
    expect(resolveLog(deep, deep)).toBe(mine);
  });
});

/**
 * POSITIVE CATCH — every one of these was RED before delulu honoured CLAUDE_CONFIG_DIR.
 *
 * Claude Code relocates its whole state directory when that variable is set, transcripts included.
 * Measured, not assumed: one `claude -p` run with it set wrote the transcript to
 * `$CLAUDE_CONFIG_DIR/projects/<slug>/<sessionId>.jsonl` and left `~/.claude/projects` untouched.
 * delulu searched only the home path, so it resolved nothing and wrote nothing — every run, for as
 * long as the variable was set. Loud rather than silent, but the tool simply did not work.
 */
describe('CLAUDE_CONFIG_DIR — Claude Code relocates its whole state directory', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dirs: string[] = [];
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  it('relocates the projects directory when the variable is set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/somewhere/else';
    expect(claudeHome()).toBe('/somewhere/else');
    expect(projectsDir()).toBe(join('/somewhere/else', 'projects'));
  });

  it('treats an empty or whitespace value as unset, never as the filesystem root', () => {
    for (const blank of ['', '   ']) {
      process.env.CLAUDE_CONFIG_DIR = blank;
      expect(projectsDir()).not.toBe('/projects');
      expect(projectsDir().endsWith(join('.claude', 'projects'))).toBe(true);
    }
  });

  it('finds a transcript that exists ONLY under the relocated config — the bug: handoff wrote nothing', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'delulu-cfg-'));
    const repo = mkdtempSync(join(tmpdir(), 'delulu-repo-'));
    dirs.push(cfg, repo);
    const dir = join(cfg, 'projects', projectSlugs(repo)[0]);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'a1b2c3d4-0000-0000-0000-000000000000.jsonl');
    writeFileSync(log, '{"type":"user","message":{"role":"user","content":"hello"}}\n');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveLog(repo)).toBe(log);
  });

  it('finds it by session id too, which is the path that beats guessing', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'delulu-cfg-'));
    const repo = mkdtempSync(join(tmpdir(), 'delulu-repo-'));
    dirs.push(cfg, repo);
    const id = 'b2c3d4e5-1111-1111-1111-111111111111';
    // A directory whose slug does NOT match the repo, so only the session-id path can find it.
    const dir = join(cfg, 'projects', '-some-other-project');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, `${id}.jsonl`);
    writeFileSync(log, '{"type":"user","message":{"role":"user","content":"hello"}}\n');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.CLAUDE_CODE_SESSION_ID = id;
    try {
      expect(resolveLog(repo)).toBe(log);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });
});
