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
  it('resolves a subdirectory to the git top-level — the bug: record empty from a subfolder', () => {
    const root = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    // A handoff written while CC ran at the root lives at the root. Running `delulu`
    // from a subdir must resolve to that same key, not to the subdir.
    expect(repoKey(sub)).toBe(root);
    expect(repoKey(root)).toBe(root);
  });

  /**
   * POSITIVE CATCH — both of these were RED before the env scrub, and the first one only goes red
   * from a SUBDIRECTORY. With `GIT_DIR` set and no `GIT_WORK_TREE`, git treats the cwd as the work
   * tree, so a call from the root returns the root by accident and the test proves nothing.
   *
   * Git exports these itself for hooks, `rebase -x` and `bisect run`. The cost of either is the
   * same and it is silent: the handoff is written under a key `resume` never looks in.
   */
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

  it('ignores a stray GIT_DIR — the bug: a subdir keyed as its own root', () => {
    const root = gitRepo();
    const other = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    // Without the scrub git reads the cwd as the work tree and answers `sub`, not `root`.
    withEnv({ GIT_DIR: join(other, '.git') }, () => {
      expect(repoKey(sub)).toBe(root);
    });
  });

  it('ignores a GIT_DIR + GIT_WORK_TREE pair — the bug: keyed to a DIFFERENT repo', () => {
    const root = gitRepo();
    const other = gitRepo();
    // Without the scrub this answers `other` — a wholly unrelated repo.
    withEnv({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }, () => {
      expect(repoKey(root)).toBe(root);
    });
  });

  /**
   * POSITIVE CATCH x3 — all three were RED before the discovery fallback, and all three fail the
   * same silent way: the handoff is written under the SUBDIRECTORY and `resume` from the root
   * reports "no handoffs yet for this project" over an artifact that is sitting on disk.
   *
   * `GIT_TEST_ASSUME_DIFFERENT_OWNER` is git's own switch for the dubious-ownership path, so this
   * exercises the real refusal rather than a mock of it. Measured on git 2.50.1: it fails from the
   * repo root too, which is why the root/subdir keys diverge instead of both being wrong together.
   */
  it('resolves to the top-level when git refuses on dubious ownership — the bug: handoff orphaned in a subdir', () => {
    const root = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, () => {
      // Proof the oracle really is refusing, not quietly succeeding and making this vacuous.
      expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: sub, stdio: 'ignore' })).toThrow();
      expect(repoKey(sub)).toBe(root);
      expect(repoKey(root)).toBe(root);
    });
  });

  it('resolves to the top-level when git is not installed — the bug: same orphan, no git binary', () => {
    const root = gitRepo();
    const sub = join(root, 'app', 'hook');
    mkdirSync(sub, { recursive: true });
    // An empty PATH is how a slim container reaches delulu: the hook runs, git does not exist.
    withEnv({ PATH: join(root, 'no-such-bin') }, () => {
      expect(repoKey(sub)).toBe(root);
    });
  });

  it('keys a linked worktree to the worktree root, not the main repo — the bug: .git is a FILE there', () => {
    const root = gitRepo();
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
    const wt = join(root, '..', `wt-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: root });
    const real = realpathSync(wt);
    temps.push(real);
    const sub = join(real, 'app');
    mkdirSync(sub, { recursive: true });
    // With git answering, this is the worktree dir. With git refusing, an existsSync that only
    // looked for a `.git` DIRECTORY would walk straight past it and key to the main repo.
    withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, () => {
      expect(repoKey(sub)).toBe(real);
    });
  });

  it('keys a BARE repo to itself, not to a repo that happens to enclose it', () => {
    // `rev-parse --show-toplevel` refuses in a bare repo on every machine, so this walk is not a
    // git-is-broken edge — it is the normal path there. A bare repo holds no `.git`, so the walk
    // used to ascend straight past it into the enclosing repo and key one project's handoffs into
    // another project's tree.
    const outer = gitRepo();
    const bare = join(outer, 'inner.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    expect(existsSync(join(bare, '.git'))).toBe(false);   // nothing for the walk to find ...
    expect(repoKey(bare)).toBe(realpathSync(bare));       // ... and it must still stop here
    expect(repoKey(bare)).not.toBe(outer);
  });

  it('keys a repo to its ROOT when run from inside its own .git — the bug: keyed to .git', () => {
    // An ordinary `.git/` holds HEAD, objects and refs exactly as a bare repo does, and
    // `--show-toplevel` fails from inside it too, so the bare-repo stop above matched it and
    // returned the `.git` directory itself — a handoff written one level below where `resume`
    // from the root looks, which is the failure this whole file exists to prevent.
    const root = gitRepo();
    expect(repoKey(join(root, '.git'))).toBe(root);
  });

  it('falls back to the realpath for a non-git directory', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'delulu-nongit-')));
    temps.push(d);
    expect(repoKey(d)).toBe(realpathSync(d));
  });
});
