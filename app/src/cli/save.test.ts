// The capture /delulu:handoff runs: the agent's note is already written, one command, one handoff out.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(out).toContain("## Last agent's summary (not checked, so confirm anything it calls done, committed or pushed with git)\nFooter fixed. Next: ship.");
    expect(out).toContain('Decided this session:\n- Keep docs plain (L1)');
    expect(out).toContain('fix the footer');
    expect(existsSync(join(base, 'note.md'))).toBe(false);
    expect(r.stdout).toMatch(/^delulu saved this session: \w{3} \d{1,2} handoff$/m);
  });

  it("names the handoff with the agent's name line, keeps it out of the summary, and never reuses a name", () => {
    const { repo, log, base } = setup([user('fix the footer'), reply('Fixed.')]);
    mkdirSync(base);
    writeFileSync(join(base, 'note.md'), 'name: Footer fix, part one!\n\nFooter fixed. Next: ship.\n');
    const first = run(repo, log);
    expect(first.stdout).toMatch(/^delulu saved this session: footer-fix-part-one$/m);
    const out = readFileSync(join(base, folders(base)[0], 'handoff.md'), 'utf8');
    expect(out.split('\n')[0]).toMatch(/^# footer-fix-part-one · delulu-save-\S+ handoff · saved /);
    expect(out).toContain('pushed with git)\nFooter fixed. Next: ship.');
    expect(out).not.toContain('name:');
    writeFileSync(join(base, 'note.md'), '**Name:** footer fix part one\nSecond pass.\n');
    expect(run(repo, log).stdout).toMatch(/^delulu saved this session: footer-fix-part-one-2$/m);
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

  it('reads the summary file named after the session, and names the handoff with it', () => {
    const { repo, log, base } = setup([user('fix the footer')]);
    mkdirSync(base);
    writeFileSync(join(base, 'footer-fix.md'), 'Mine.\n');
    writeFileSync(join(base, 'other-window.md'), 'The other window.\n');
    const r = spawnSync('node', [SAVE, 'footer-fix', '--repo', repo, '--log', log], { encoding: 'utf8', env });
    expect(r.stdout).toMatch(/^delulu saved this session: footer-fix$/m);
    const out = readFileSync(join(base, folders(base)[0], 'handoff.md'), 'utf8');
    expect(out.split('\n')[0]).toMatch(/^# footer-fix · /);
    expect(out).toContain('Mine.');
    expect(out).not.toContain('The other window.');
    expect(existsSync(join(base, 'footer-fix.md'))).toBe(false);
    expect(readFileSync(join(base, 'other-window.md'), 'utf8')).toBe('The other window.\n');
  });

  it('never reads a file outside the handoff folder, whatever name it is given', () => {
    const { repo, log, base } = setup([user('go')]);
    mkdirSync(base);
    writeFileSync(join(repo, 'secret.md'), 'Not a summary.\n');
    const r = spawnSync('node', [SAVE, '../secret', '--repo', repo, '--log', log], { encoding: 'utf8', env });
    expect(r.stdout).toContain('No summary was written');
    expect(readFileSync(join(base, folders(base)[0], 'handoff.md'), 'utf8')).not.toContain('Not a summary.');
    expect(existsSync(join(repo, 'secret.md'))).toBe(true);
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

  it('refuses a session with no messages from the user and saves nothing, but still keeps the folder out of git', () => {
    const { repo, log, base } = setup([reply('hello')]);
    const r = run(repo, log);
    expect(r.status).toBe(1);
    expect(existsSync(base)).toBe(false);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.delulu-handoff/');
  });

  it('keeps handoffs out of git, without counting that edit as the user\'s change next time', () => {
    const { repo, log, base } = setup([user('go')]);
    run(repo, log);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.delulu-handoff/');
    run(repo, log);
    expect(readFileSync(join(base, folders(base).at(-1)!, 'handoff.md'), 'utf8')).toContain('no uncommitted files');
  });

  it('counts a file of the user\'s whose name only starts like the handoff folder', () => {
    const { repo, log, base } = setup([user('go')]);
    writeFileSync(join(repo, '.delulu-handoff-notes.txt'), 'mine');
    run(repo, log);
    expect(readFileSync(join(base, folders(base).at(-1)!, 'handoff.md'), 'utf8')).toContain('1 uncommitted file');
  });

  it('refuses to save through a .delulu-handoff that links somewhere else, and writes nothing there', () => {
    const { repo, log } = setup([user('go')]);
    const elsewhere = mkdtempSync(join(tmpdir(), 'delulu-elsewhere-'));
    made.push(elsewhere);
    symlinkSync(elsewhere, join(repo, '.delulu-handoff'));
    const out = run(repo, log);
    expect(out.stdout).toContain('nothing was saved');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
