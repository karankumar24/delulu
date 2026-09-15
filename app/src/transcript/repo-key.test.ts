import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoKey } from './repo-key';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function gitRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'delulu-key-')));
  temps.push(d);
  execFileSync('git', ['init'], { cwd: d });
  return d;
}

describe('repoKey', () => {
  it('resolves a subdirectory to the git top level', () => {
    const root = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    expect(repoKey(sub)).toBe(root);
    expect(repoKey(root)).toBe(root);
  });

  // Git exports GIT_DIR and friends to hooks, `rebase -x` and `bisect run`.
  function withEnv(vars: Record<string, string>, fn: () => void): void {
    const saved = Object.entries(vars).map(([k]) => [k, process.env[k]] as const);
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('ignores a stray GIT_DIR when run from a subdirectory', () => {
    const root = gitRepo();
    const other = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    // Without the scrub git reads the cwd as the work tree and answers `sub`, not `root`.
    withEnv({ GIT_DIR: join(other, '.git') }, () => {
      expect(repoKey(sub)).toBe(root);
    });
  });

  it('ignores a GIT_DIR and GIT_WORK_TREE pair pointing at another repo', () => {
    const root = gitRepo();
    const other = gitRepo();
    // Without the scrub this answers `other`.
    withEnv({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }, () => {
      expect(repoKey(root)).toBe(root);
    });
  });

  // When git cannot answer, the walk up must still find the top level, or a handoff saved from a
  // subdirectory is invisible to resume run from the root.
  it('resolves to the top level when git refuses on dubious ownership', () => {
    const root = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, () => {
      // Not every git honours this switch; where nothing is refused there is no branch to test.
      let refuses = false;
      try {
        execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: sub, stdio: 'ignore' });
      } catch {
        refuses = true;
      }
      if (!refuses) {
        console.warn('SKIP: this git does not refuse under GIT_TEST_ASSUME_DIFFERENT_OWNER');
        return;
      }
      expect(repoKey(sub)).toBe(root);
      expect(repoKey(root)).toBe(root);
    });
  });

  it('resolves to the top level when git is not installed', () => {
    const root = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    // An empty PATH is how a slim container reaches delulu: the hook runs, git does not exist.
    withEnv({ PATH: join(root, 'no-such-bin') }, () => {
      expect(repoKey(sub)).toBe(root);
    });
  });

  it('keys a linked worktree to the worktree root, where .git is a file', () => {
    const root = gitRepo();
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
    const wt = join(root, '..', `wt-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: root });
    const real = realpathSync(wt);
    temps.push(real);
    const sub = join(real, 'app');
    mkdirSync(sub, { recursive: true });
    // With git refusing, the walk must accept a `.git` file, not only a directory.
    withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, () => {
      expect(repoKey(sub)).toBe(real);
    });
  });

  it('keys a bare repo to itself, not to a repo that encloses it', () => {
    // `rev-parse --show-toplevel` always refuses in a bare repo, so the walk is the normal path there.
    const outer = gitRepo();
    const bare = join(outer, 'inner.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    expect(existsSync(join(bare, '.git'))).toBe(false);   // nothing for the walk to find ...
    expect(repoKey(bare)).toBe(realpathSync(bare));       // ... and it must still stop here
    expect(repoKey(bare)).not.toBe(outer);
  });

  it('keys a repo to its root when run from inside its own .git', () => {
    const root = gitRepo();
    expect(repoKey(join(root, '.git'))).toBe(root);
  });

  it('falls back to the realpath for a non-git directory', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'delulu-nongit-')));
    temps.push(d);
    expect(repoKey(d)).toBe(realpathSync(d));
  });
});
