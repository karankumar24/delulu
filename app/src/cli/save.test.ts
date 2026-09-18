// The capture /delulu:handoff runs: the agent's note is already written, one command, one handoff out.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const BUNDLES = mkdtempSync(join(tmpdir(), 'delulu-save-bundle-'));
const SAVE = join(BUNDLES, 'save.mjs');
beforeAll(async () => {
  await build({ bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', entryPoints: [resolve(process.cwd(), 'src/cli/save.ts')], outfile: SAVE });
});
afterAll(() => rmSync(BUNDLES, { recursive: true, force: true }));

const made: string[] = [];
afterEach(() => { while (made.length) rmSync(made.pop()!, { recursive: true, force: true }); });
const env = (() => { const e = { ...process.env }; delete e.CLAUDE_CODE_SESSION_ID; return e; })();
const at = () => new Date().toISOString();
const user = (text: string) => ({ type: 'user', uuid: `u-${Math.random()}`, timestamp: at(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
const reply = (text: string) => ({ type: 'assistant', uuid: `a-${Math.random()}`, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } });

function setup(recs: object[]): { repo: string; log: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), 'delulu-save-'));
  const logs = mkdtempSync(join(tmpdir(), 'delulu-save-log-'));
  made.push(repo, logs);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t.io', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: repo });
  const log = join(logs, 'session.jsonl');
  writeFileSync(log, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { repo, log, base: join(repo, '.delulu-handoff') };
}
const run = (repo: string, log: string) => spawnSync('node', [SAVE, '--repo', repo, '--log', log], { encoding: 'utf8', env });
const folders = (base: string) => readdirSync(base).filter((f) => /^\d{4}-/.test(f)).sort();

describe('save', () => {
  it('writes one handoff from the note and the transcript, and removes the note so it is never reused', () => {
    const { repo, log, base } = setup([user('fix the footer'), reply('Fixed.')]);
    mkdirSync(base);
    writeFileSync(join(base, 'note.md'), 'Footer fixed. Next: ship.\n\nDecided this session:\n- Keep docs plain (L1)\n');
    const r = run(repo, log);
    expect(r.status).toBe(0);
    expect(folders(base)).toHaveLength(1);
    const out = readFileSync(join(base, folders(base)[0], 'handoff.md'), 'utf8');
    expect(out).toContain("## Last agent's summary (not checked)\nFooter fixed. Next: ship.");
    expect(out).toContain('Decided this session:\n- Keep docs plain (L1)');
    expect(out).toContain('fix the footer');
    expect(existsSync(join(base, 'note.md'))).toBe(false);
    expect(r.stdout).toContain(folders(base)[0]);
  });

  it('still saves when no note was written, and says so', () => {
    const { repo, log } = setup([user('fix the footer')]);
    const r = run(repo, log);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No summary was written');
  });

  it('copies nothing from an earlier handoff: a handoff is about the one session it saves', () => {
    const { repo, log, base } = setup([user('go')]);
    mkdirSync(join(base, '2026-09-01T10-00-00'), { recursive: true });
    writeFileSync(join(base, '2026-09-01T10-00-00', 'handoff.md'), '# x\n\n## Standing rules\n- Ask before subagents. "ask me" (a:L2)\n');
    writeFileSync(join(base, 'note.md'), 'Summary.\n');
    const r = run(repo, log);
    const out = readFileSync(join(base, folders(base).at(-1)!, 'handoff.md'), 'utf8');
    expect(out).not.toContain('Ask before subagents');
    expect(r.stdout).not.toMatch(/rule/i);
  });

  it("reads only this session's own note, so a second window saving in the same folder keeps its summary", () => {
    const { repo, log, base } = setup([user('fix the footer')]);
    mkdirSync(base);
    writeFileSync(join(base, 'note-aaaaaaaa-1.md'), 'Mine.\n');
    writeFileSync(join(base, 'note-bbbbbbbb-2.md'), 'The other window.\n');
    const r = spawnSync('node', [SAVE, '--repo', repo, '--log', log], { encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1' } });
    expect(r.status).toBe(0);
    const out = readFileSync(join(base, folders(base)[0], 'handoff.md'), 'utf8');
    expect(out).toContain('Mine.');
    expect(out).not.toContain('The other window.');
    expect(existsSync(join(base, 'note-aaaaaaaa-1.md'))).toBe(false);
    expect(readFileSync(join(base, 'note-bbbbbbbb-2.md'), 'utf8')).toBe('The other window.\n');
  });

  it("falls back to a plain note.md when this session's own note is missing", () => {
    const { repo, log, base } = setup([user('go')]);
    mkdirSync(base);
    writeFileSync(join(base, 'note.md'), 'Plain.\n');
    spawnSync('node', [SAVE, '--repo', repo, '--log', log], { encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1' } });
    expect(readFileSync(join(base, folders(base)[0], 'handoff.md'), 'utf8')).toContain('Plain.');
  });

  it('never removes an older handoff to make room for one saved without a summary', () => {
    const { repo, log, base } = setup([user('go')]);
    for (let k = 10; k < 25; k++) {
      mkdirSync(join(base, `2026-09-${k}T10-00-00`), { recursive: true });
      writeFileSync(join(base, `2026-09-${k}T10-00-00`, 'handoff.md'), '# x\n');
    }
    const r = run(repo, log);
    expect(folders(base)).toHaveLength(16);
    expect(r.stdout).toContain('no older handoff was removed');
    writeFileSync(join(base, 'note.md'), 'Summary.\n');
    run(repo, log);
    expect(folders(base)).toHaveLength(15);
  });

  it('refuses a session with no messages from the user, and writes nothing', () => {
    const { repo, log, base } = setup([reply('hello')]);
    const r = run(repo, log);
    expect(r.status).toBe(1);
    expect(existsSync(base)).toBe(false);
  });

  it('keeps handoffs out of git, without counting that edit as the user\'s change next time', () => {
    const { repo, log, base } = setup([user('go')]);
    run(repo, log);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.delulu-handoff/');
    run(repo, log);
    expect(readFileSync(join(base, folders(base).at(-1)!, 'handoff.md'), 'utf8')).toContain('no uncommitted files');
  });
});
