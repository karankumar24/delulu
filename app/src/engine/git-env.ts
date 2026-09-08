// delulu engine — the environment every git call delulu makes runs in.
//
// `GIT_DIR` and its siblings OVERRIDE both `-C` and the cwd. Measured, not assumed: with `GIT_DIR`
// pointing at another repo, `git -C <this repo> rev-parse --abbrev-ref HEAD` prints the OTHER
// repo's branch, and `--show-toplevel` returns the other repo's root.
//
// Git exports these itself — for hooks, `rebase -x`, `bisect run`, `filter-branch`, and the editor
// it opens for a commit message — so a delulu run started from inside any of those would print
// another repo's branch, sha and dirty state under the heading that promises they were read from
// THIS repo, and would key the handoff to a root `resume` never looks in. Both failures are silent.
//
// Stripping them is what makes `-C <repo>` mean what it reads as. Nothing else in the environment
// is touched: `GIT_CONFIG_*`, credentials and the rest are the user's business, and a git that
// cannot run is already handled by every caller falling back.
const REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
] as const;

export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of REPO_LOCATION_VARS) delete env[k];
  return env;
}
