// The repo a command belongs to: its git top level, so a command run from any subfolder finds the same
// handoffs.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git, gitEnv } from './git';

/** The key for a repo: its git top level, or the directory itself when it is in no repo. */
export function repoKey(dir: string): string {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      env: gitEnv(),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (top) return realpathSync(top);
  } catch {
    /* git could not answer: walk up instead */
  }
  // Throws for a path that does not exist, so the caller never creates a folder that is not the repo.
  const here = realpathSync(dir);
  return discoverRoot(here) ?? here;
}

/** Where a repo's handoffs live: its main checkout, so every git worktree of it shares one set. */
export function handoffHome(repo: string): string {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common || basename(common) !== '.git') return repo;
  try { return realpathSync(dirname(common)); } catch { return repo; }
}

/** Every checkout of the repo, this one first: the folders its sessions can run in. */
export function checkouts(repo: string): string[] {
  const listed = (git(repo, ['worktree', 'list', '--porcelain']) ?? '').split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => { const p = l.slice('worktree '.length); try { return realpathSync(p); } catch { return p; } });
  return [...new Set([repo, ...listed])];
}

/**
 * Git's own discovery, for when git cannot answer (not installed, dubious ownership, a timeout): walk
 * up to a directory holding `.git`, which is a file in a worktree or submodule, stopping at a
 * filesystem boundary.
 */
function discoverRoot(from: string): string | undefined {
  let dir = from;
  let dev: number;
  try {
    dev = statSync(dir).dev;
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    // A bare repo holds no `.git`: it is its own git directory. Reached from inside an ordinary
    // repo's `.git`, the root is the work tree beside it.
    if (existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs'))) {
      return basename(dir) === '.git' ? dirname(dir) : dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    // Git stops at a filesystem boundary, and so does this; an unreadable parent stops it too.
    try {
      if (statSync(parent).dev !== dev) return undefined;
    } catch {
      return undefined;
    }
    dir = parent;
  }
}
