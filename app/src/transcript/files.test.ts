// Which files an agent changed, read from its tool calls.

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mutatedFiles } from './files';
import type { ParsedSession, SessionEvent } from './tail';

let line = 0;
const call = (toolName: string, toolInput: Record<string, unknown>, toolUseId?: string, cwd?: string): SessionEvent =>
  ({ kind: 'tool', line: ++line, toolName, toolInput, toolUseId, cwd });
const res = (toolUseId: string, ok: boolean): SessionEvent => ({ kind: 'tool-result', line: ++line, toolUseId, ok });
const session = (...events: SessionEvent[]): ParsedSession => ({ events, unreadable: [] });

describe('which tools change files', () => {
  const touched = (name: string) => mutatedFiles(session(call(name, { file_path: '/repo/x.ts' })));

  it('recognises the built-in writers regardless of case', () => {
    for (const n of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'EDIT']) {
      expect(touched(n)).toEqual(['/repo/x.ts']);
    }
  });

  it('recognises MCP filesystem servers exposing the same capability', () => {
    for (const n of ['mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__fs__create_notebook']) {
      expect(touched(n)).toEqual(['/repo/x.ts']);
    }
  });

  it('does not count a reader or a shell', () => {
    for (const n of ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'mcp__filesystem__read_file']) {
      expect(touched(n)).toEqual([]);
    }
  });
});

describe('mutatedFiles', () => {
  it('lists distinct mutated files in first-touch order', () => {
    const s = session(
      call('Write', { file_path: '/repo/a.ts' }),
      call('Edit', { file_path: '/repo/b.ts' }),
      call('Edit', { file_path: '/repo/a.ts' }),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('does not count a write the user refused or an edit that errored', () => {
    const s = session(
      call('Write', { file_path: '/repo/blocked.ts' }, 't1'),
      res('t1', false),
      call('Edit', { file_path: '/repo/real.ts' }, 't2'),
      res('t2', true),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/real.ts']);
  });

  it('counts a call with no result recorded yet', () => {
    const s = session(call('Write', { file_path: '/repo/inflight.ts' }, 't9'));
    expect(mutatedFiles(s)).toEqual(['/repo/inflight.ts']);
  });

  it('resolves a relative path against the cwd recorded on the call', () => {
    const s = session(
      call('Edit', { file_path: '/repo/a.ts' }, undefined, '/repo'),
      call('Edit', { file_path: './sub/../a.ts' }, undefined, '/repo'),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/a.ts']);
  });

  it('keeps a relative path raw when no cwd was recorded, rather than inventing one', () => {
    expect(mutatedFiles(session(call('Edit', { file_path: 'rel/only.ts' })))).toEqual(['rel/only.ts']);
  });

  it('expands ~/ against the home directory', () => {
    const s = session(call('Edit', { file_path: '~/.zshrc' }, undefined, '/repo'));
    expect(mutatedFiles(s)).toEqual([join(homedir(), '.zshrc')]);
  });

  it('reads every path field the mutating tools actually use', () => {
    const s = session(
      call('Write', { path: '/repo/p.ts' }),
      call('NotebookEdit', { notebook_path: '/repo/n.ipynb' }),
      call('EditNotebook', { target_notebook: '/repo/t.ipynb' }),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/p.ts', '/repo/n.ipynb', '/repo/t.ipynb']);
  });

  it('skips a mutating call that carries no path at all, without crashing', () => {
    expect(mutatedFiles(session(call('Edit', {}), call('Write', { file_path: '/repo/ok.ts' })))).toEqual(['/repo/ok.ts']);
  });

  it('counts a text-editor call that writes', () => {
    const s = session(call('str_replace_editor', { command: 'str_replace', path: '/repo/edited.ts' }));
    expect(mutatedFiles(s)).toEqual(['/repo/edited.ts']);
  });

  it('does not count a text-editor call that only views', () => {
    const s = session(call('str_replace_editor', { command: 'view', path: '/repo/only-read.ts' }));
    expect(mutatedFiles(s)).toEqual([]);
  });

  it('counts create, insert and undo_edit, and ignores an absent or unknown command', () => {
    for (const command of ['create', 'insert', 'undo_edit']) {
      expect(mutatedFiles(session(call('str_replace_based_edit_tool', { command, path: '/repo/x.ts' })))).toEqual(['/repo/x.ts']);
    }
    // No command at all, or one nobody has heard of: undercounting is the safe direction.
    expect(mutatedFiles(session(call('str_replace_editor', { path: '/repo/x.ts' })))).toEqual([]);
    expect(mutatedFiles(session(call('str_replace_editor', { command: 'sneak', path: '/repo/x.ts' })))).toEqual([]);
  });

  it('resolves Windows paths against a Windows cwd', () => {
    const s = session(
      call('Edit', { file_path: 'C:\\repo\\src\\a.ts' }, undefined, 'C:\\repo'),
      call('Write', { file_path: 'src\\b.ts' }, undefined, 'C:\\repo'),
      call('Edit', { file_path: '.\\sub\\..\\c.ts' }, undefined, 'C:\\repo'),
    );
    expect(mutatedFiles(s)).toEqual(['C:\\repo\\src\\a.ts', 'C:\\repo\\src\\b.ts', 'C:\\repo\\c.ts']);
  });

  it('counts one Windows file once, however the transcript spelled it', () => {
    const s = session(
      call('Edit', { file_path: 'C:\\Repo\\A.ts' }, undefined, 'C:\\Repo'),
      call('Edit', { file_path: 'c:\\repo\\a.ts' }, undefined, 'C:\\repo'),
      call('Edit', { file_path: 'C:/Repo/A.ts' }, undefined, 'C:\\Repo'),
    );
    expect(mutatedFiles(s)).toEqual(['C:\\Repo\\A.ts']);
  });

  it('still keeps two POSIX files that differ only in case as two files', () => {
    const s = session(
      call('Edit', { file_path: '/repo/A.ts' }, undefined, '/repo'),
      call('Edit', { file_path: '/repo/a.ts' }, undefined, '/repo'),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/A.ts', '/repo/a.ts']);
  });

  it('ignores non-mutating tools and non-tool events entirely', () => {
    const s = session(
      { kind: 'user', line: ++line, text: 'please edit /repo/mentioned.ts' },
      { kind: 'text', line: ++line, text: 'I will edit /repo/promised.ts next' },
      call('Bash', { command: 'echo hi > /repo/shell.ts' }),
      call('Write', { file_path: '/repo/actual.ts' }),
    );
    // Prose is never consulted: a promise or a paraphrase cannot add a file to this set.
    expect(mutatedFiles(s)).toEqual(['/repo/actual.ts']);
  });
});
