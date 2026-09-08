import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gitEnv } from './git-env';

/**
 * Canonical ledger key for a repo: the git top-level directory.
 *
 * Handoffs are written to `.delulu-handoff/` at the repo root, so they must be keyed by the root.
 * Without this, `delulu` reads the raw cwd — so running a command from any subfolder finds nothing
 * and the directory looks empty. Keying everything by the git top-level means a read from any
 * subdirectory resolves to the same key as the write. Falls back to the realpath'd dir for non-git
 * paths, and is behavior-identical when the dir already IS the top-level.
 */
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
    /* git could not answer — fall through to the walk below */
  }
  // Throw rather than hand back a path that does not resolve. Returning `dir` made the caller's
  // `failed('not a readable path')` branch unreachable, and `mkdirSync(recursive: true)` then
  // CREATED the whole tree: one mistyped character, or an unmounted network volume, and the session
  // was captured into a directory that is not the repository, reported as success, and hidden the
  // moment the real volume mounted over it.
  const here = realpathSync(dir);
  return discoverRoot(here) ?? here;
}

/**
 * Git's own repo discovery, for the case where git itself cannot answer.
 *
 * The `catch` above does not fire only for "this is not a repository". Measured: git exits 128 with
 * `detected dubious ownership` for a repo owned by another uid — the default inside a container, and
 * the reason CI images ship `safe.directory` incantations — and it fails that way from the REPO ROOT
 * as readily as from a subfolder. A missing git exits 127; a hung one hits the five-second timeout.
 * Every one of those landed on `realpathSync(dir)`, so `handoff` run from `app/hook` wrote
 * `.delulu-handoff/` into `app/hook`, and `resume` from the root then said there were no handoffs
 * for this project. The artifact existed and was unreachable, which is the exact failure the
 * docstring above says this file was written to prevent.
 *
 * This is not a second, competing definition of "repo root". It is what git documents its own
 * discovery to be: ascend from the starting directory looking for a `.git` entry, stopping at a
 * filesystem boundary. `.git` is checked with `existsSync` because a linked worktree and a submodule
 * both mark their root with a `.git` FILE rather than a directory — verified: in a worktree,
 * `rev-parse --show-toplevel` returns the worktree dir, which is precisely the dir holding that file.
 *
 * Because it runs ONLY when git declined to answer, it can never contradict git; it returns what git
 * would have returned had it been able to run. The one behavior it deliberately keeps is the last
 * resort: a directory under no repository at all still keys to itself, exactly as before.
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
    // A BARE repository is its own git directory — there is no `.git` inside it to find, and
    // `rev-parse --show-toplevel` refuses outright ("this operation must be run in a work tree"),
    // so a bare repo reaches this walk on EVERY machine, not only where git is fenced off. Without
    // this the walk sails past it and keys the handoff to whatever ordinary repo happens to
    // enclose it — writing one project's `.delulu-handoff/` inside another project, which is the
    // wrong-repo failure the top of this file exists to prevent. Detected on disk rather than by
    // asking git, because git being unable to answer is how we got here.
    //
    // An ordinary repo's own `.git/` holds HEAD, objects and refs too, and `--show-toplevel` fails
    // from inside it for the same reason — so this test alone keyed a repo to its `.git` directory
    // when run from in there, which is the same lost-handoff shape one level down. A `.git` is
    // never a root: the root is the work tree beside it.
    if (existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs'))) {
      return basename(dir) === '.git' ? dirname(dir) : dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    // Git stops discovery at a filesystem boundary unless GIT_DISCOVERY_ACROSS_FILESYSTEM is set.
    // Ascending past one would find a root git would not, which is the one way this could disagree
    // with the oracle it stands in for. An unreadable parent stops the walk for the same reason.
    try {
      if (statSync(parent).dev !== dev) return undefined;
    } catch {
      return undefined;
    }
    dir = parent;
  }
}
