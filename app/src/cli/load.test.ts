// What /delulu:resume prints into a fresh session: which handoff, when, what changed since, how to carry
// on, and the handoff itself. It asks nothing and works the same for any user.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { projectSlugs } from './resolve-log';

const BUNDLES = mkdtempSync(join(tmpdir(), 'delulu-load-bundle-'));
const LOAD = join(BUNDLES, 'load.mjs');
beforeAll(async () => {
  await build({ bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', entryPoints: [resolve(process.cwd(), 'src/cli/load.ts')], outfile: LOAD });
});
afterAll(() => rmSync(BUNDLES, { recursive: true, force: true }));

const made: string[] = [];
afterEach(() => { while (made.length) rmSync(made.pop()!, { recursive: true, force: true }); });
const temp = (name: string) => { const d = mkdtempSync(join(tmpdir(), name)); made.push(d); return realpathSync(d); };
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t.io', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();

function repoWith(): { repo: string; base: string; config: string } {
  const repo = temp('delulu-load-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
  return { repo, base: join(repo, '.delulu-handoff'), config: temp('delulu-load-config-') };
}
function handoff(base: string, folder: string, body: string): void {
  mkdirSync(join(base, folder), { recursive: true });
  writeFileSync(join(base, folder, 'handoff.md'), body);
}
const run = (repo: string, config: string, ...words: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync('node', [LOAD, '--repo', repo, ...words], { encoding: 'utf8', env });
};

describe('load: which handoff', () => {
  it('says plainly when there is no handoff yet', () => {
    const { repo, config } = repoWith();
    const r = run(repo, config);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no handoffs yet for this project');
  });

  it('loads the handoff created last, whatever its name says, with the time and how to carry on', async () => {
    const { repo, base, config } = repoWith();
    handoff(base, '2026-09-15T10-00-00', '# p handoff\nFIRST\n');
    // Far enough apart that the two folders cannot share a creation time, which is what orders them.
    await new Promise((done) => { setTimeout(done, 20); });
    handoff(base, '2026-09-14T09-00-00', '# p handoff\nSECOND\n');
    const r = run(repo, config);
    expect(r.stdout).toContain('SECOND');
    expect(r.stdout).not.toContain('FIRST');
    expect(r.stdout).toMatch(/^delulu resume: Sep 14 handoff, saved Sep 14 at 9:00 AM/);
    expect(r.stdout).toContain('How to carry on:');
    expect(r.stdout).not.toContain('AskUserQuestion');
  });

  it("treats words that name no handoff as the user's first instruction, and loads a handoff they do name", () => {
    const { repo, base, config } = repoWith();
    handoff(base, '2026-09-10T08-00-00', '# p handoff\nOLDER\n');
    handoff(base, '2026-09-12T08-00-00', '# p handoff\nNEWER\n');
    const words = run(repo, config, 'and', 'look', 'at', 'the', 'codex', 'work');
    expect(words.stdout).toContain('NEWER');
    expect(words.stdout).toContain('When resuming, the user added: and look at the codex work');
    const named = run(repo, config, '2026-09-10');
    expect(named.stdout).toContain('OLDER');
    expect(named.stdout).not.toContain('the user added');
  });
});

describe('load: what changed since', () => {
  it('reports commits made since the save, and uncommitted files', () => {
    const { repo, base, config } = repoWith();
    const saved = git(repo, 'rev-parse', '--short', 'HEAD');
    handoff(base, '2026-09-15T10-00-00', `# p handoff\n\n## Repo when saved\nBranch \`main\` at \`${saved}\`, no uncommitted files\n`);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'after');
    writeFileSync(join(repo, 'new.txt'), 'x');
    const r = run(repo, config);
    expect(r.stdout).toContain('Since the save: 1 new commit on `main`');
    expect(r.stdout).toContain('1 uncommitted file.'); // delulu's own folder is not the user's change
  });

  it("does not count the line delulu adds to .gitignore as the user's change", () => {
    const { repo, base, config } = repoWith();
    writeFileSync(join(repo, '.gitignore'), 'node_modules');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    const saved = git(repo, 'rev-parse', '--short', 'HEAD');
    handoff(base, '2026-09-15T10-00-00', `# p handoff\n\n## Repo when saved\nBranch \`main\` at \`${saved}\`, no uncommitted files\n`);
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.delulu-handoff/\n');
    expect(run(repo, config).stdout).toContain('0 uncommitted files.');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.delulu-handoff/\ndist/\n');
    expect(run(repo, config).stdout).toContain('1 uncommitted file.');
  });

  it('warns about sessions in this project active after the save that were never saved', () => {
    const { repo, base, config } = repoWith();
    handoff(base, '2026-09-15T10-00-00', '# p handoff\nTranscript: ~/x/aaaaaaaa-1.jsonl (L123 means line 123 of it)\n');
    const dir = join(config, 'projects', projectSlugs(repo)[0]);
    mkdirSync(dir, { recursive: true });
    const later = new Date(Date.now() + 600_000);
    for (const id of ['aaaaaaaa-1', 'bbbbbbbb-2']) { writeFileSync(join(dir, `${id}.jsonl`), '{}\n'); utimesSync(join(dir, `${id}.jsonl`), later, later); }
    const r = run(repo, config);
    expect(r.stdout).toContain('1 session in this project was active after this was saved and was never saved');
    expect(r.stdout).toContain('bbbbbbbb');
    expect(r.stdout).not.toMatch(/aaaaaaaa \(/);
  });

  it('judges a session by its last record, not by a file date the app bumped on an old transcript', () => {
    const { repo, base, config } = repoWith();
    handoff(base, '2026-09-15T10-00-00', '# p handoff\nTranscript: ~/x/aaaaaaaa-1.jsonl (L123 means line 123 of it)\n');
    const dir = join(config, 'projects', projectSlugs(repo)[0]);
    mkdirSync(dir, { recursive: true });
    const later = new Date(Date.now() + 600_000);
    const old = join(dir, 'cccccccc-3.jsonl');
    writeFileSync(old, '{"type":"user","timestamp":"2026-09-08T16:53:20.427Z"}\n{"type":"last-prompt"}\n');
    utimesSync(old, later, later);
    expect(run(repo, config).stdout).not.toContain('Heads up');
  });

  it('prints a handoff too big for one output in part, with exactly how to read the rest', () => {
    const { repo, base, config } = repoWith();
    handoff(base, '2026-09-15T10-00-00', `# p handoff\n${'- a line of the handoff that keeps going\n'.repeat(1500)}END\n`);
    const r = run(repo, config);
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(30_000);
    expect(r.stdout).toMatch(/The handoff continues\. Read the rest before replying: .*handoff\.md, from line \d+\./);
    expect(r.stdout).not.toContain('END');
  });

  it('lists handoffs newest first', () => {
    const { repo, base, config } = repoWith();
    handoff(base, '2026-09-10T08-00-00', '# a\n');
    handoff(base, '2026-09-12T08-00-00', '# b\n');
    const lines = run(repo, config, '--list').stdout.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => l.slice(0, 16))).toEqual(['- Sep 12 handoff', '- Sep 10 handoff']);
  });
});
