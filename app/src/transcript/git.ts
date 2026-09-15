// Every git call delulu makes. GIT_DIR and its siblings override -C, and git exports them to the hooks
// and editors it starts, so they are cleared to make -C mean the repo it names.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Output of git run in `repo`, or undefined when git fails or is missing. */
export function git(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args],
      { env: gitEnv(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return undefined; }
}

/** Uncommitted files, leaving out delulu's own folder and the line it adds to .gitignore. */
export function uncommitted(repo: string): number | undefined {
  const status = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  if (status === undefined) return undefined;
  return status.split('\n').filter(Boolean).filter((row) => {
    const path = row.trim().replace(/^\S{1,2}\s+/, '');
    if (path.startsWith('.delulu-handoff')) return false;
    return path !== '.gitignore' || !onlyDeluluLine(repo, row.trim().startsWith('??'));
  }).length;
}

/** True when the only change to .gitignore is the `.delulu-handoff/` line. */
function onlyDeluluLine(repo: string, untracked: boolean): boolean {
  let added: string[];
  let removed: string[] = [];
  if (untracked) {
    try { added = readFileSync(join(repo, '.gitignore'), 'utf8').split('\n'); } catch { return false; }
  } else {
    const diff = git(repo, ['diff', 'HEAD', '-U0', '--', '.gitignore']);
    if (diff === undefined) return false;
    const rows = diff.split('\n');
    added = rows.filter((r) => r.startsWith('+') && !r.startsWith('+++')).map((r) => r.slice(1));
    removed = rows.filter((r) => r.startsWith('-') && !r.startsWith('---')).map((r) => r.slice(1));
  }
  // A last line that only gained its newline shows as removed and added again.
  const moved = removed.filter((r) => added.includes(r));
  added = added.filter((r) => r.trim() && !moved.includes(r));
  removed = removed.filter((r) => !moved.includes(r));
  return !removed.length && added.length > 0 && added.every((r) => /^\.delulu-handoff\/?\s*$/.test(r));
}
