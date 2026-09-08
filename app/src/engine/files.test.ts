// delulu engine — "Files touched" unit tests.
//
// This module had NO test file while producing a line the payload prints under an engine-verified
// heading. Its own JSDoc records two defects it already shipped — counting a REJECTED write as a
// file the agent touched, and counting `./a/../a.ts` and `/repo/a.ts` as two files — so the rules
// below are the ones that were learned the expensive way, and nothing was binding them.

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mutatedFiles, isMutatingTool, isMutatingCall } from './files';
import type { ParsedSession, SessionEvent } from './tail';

let line = 0;
const call = (toolName: string, toolInput: Record<string, unknown>, toolUseId?: string, cwd?: string): SessionEvent =>
  ({ kind: 'tool', line: ++line, toolName, toolInput, toolUseId, cwd });
const res = (toolUseId: string, ok: boolean): SessionEvent => ({ kind: 'tool-result', line: ++line, toolUseId, ok });
const session = (...events: SessionEvent[]): ParsedSession => ({ events, unreadable: [] });

describe('isMutatingTool', () => {
  it('recognises the built-in writers regardless of case', () => {
    for (const n of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'EDIT']) {
      expect(isMutatingTool(n)).toBe(true);
    }
  });

  it('recognises MCP filesystem servers exposing the same capability', () => {
    // Matching only the built-in names meant a file written through an MCP server never appeared
    // in "Files touched" at all.
    expect(isMutatingTool('mcp__filesystem__write_file')).toBe(true);
    expect(isMutatingTool('mcp__filesystem__edit_file')).toBe(true);
    expect(isMutatingTool('mcp__fs__create_notebook')).toBe(true);
  });

  it('does not claim a reader or a shell touched anything', () => {
    // Bash CAN write files, and is deliberately excluded: the payload line says so in words rather
    // than guessing from a command string.
    for (const n of ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'mcp__filesystem__read_file']) {
      expect(isMutatingTool(n)).toBe(false);
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

  it('does NOT count a write the user rejected or an edit that errored', () => {
    // The worst version of this: the next session reads "Files touched: never-written.ts" for a
    // change the user explicitly blocked, while WHAT FAILED reports the same call as an error.
    const s = session(
      call('Write', { file_path: '/repo/blocked.ts' }, 't1'),
      res('t1', false),
      call('Edit', { file_path: '/repo/real.ts' }, 't2'),
      res('t2', true),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/real.ts']);
  });

  it('DOES count a call with no result recorded — in-flight is not failure', () => {
    const s = session(call('Write', { file_path: '/repo/inflight.ts' }, 't9'));
    expect(mutatedFiles(s)).toEqual(['/repo/inflight.ts']);
  });

  it('resolves a relative path against the cwd recorded on the call', () => {
    // Counted twice AND dropped downstream: the raw string failed the repo-prefix test, so the
    // file vanished from the block while inflating its total.
    const s = session(
      call('Edit', { file_path: '/repo/a.ts' }, undefined, '/repo'),
      call('Edit', { file_path: './sub/../a.ts' }, undefined, '/repo'),
    );
    expect(mutatedFiles(s)).toEqual(['/repo/a.ts']);
  });

  it('keeps a relative path raw when no cwd was recorded, rather than inventing one', () => {
    // Anchoring to delulu's OWN process directory would name a path the agent never touched.
    expect(mutatedFiles(session(call('Edit', { file_path: 'rel/only.ts' })))).toEqual(['rel/only.ts']);
  });

  it('expands ~/ instead of building a <cwd>/~/ path that cannot exist', () => {
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

  /**
   * The text-editor tools decide by ARGUMENT, not by name: `str_replace_editor` and
   * `str_replace_based_edit_tool` take `command: view | create | str_replace | insert | undo_edit`,
   * and only four of the five write. Listing them by name alone reported a file the session merely
   * VIEWED under "Files touched via Write/Edit" — a false claim in the engine-verified block, on a
   * line whose own text names the two tools it means.
   */
  it('counts a text-editor call that WRITES', () => {
    const s = session(call('str_replace_editor', { command: 'str_replace', path: '/repo/edited.ts' }));
    expect(mutatedFiles(s)).toEqual(['/repo/edited.ts']);
  });

  it('does NOT count a text-editor call that only views — the bug: a read reported as a write', () => {
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

  it('keeps the name-only predicate honest about what a name cannot decide', () => {
    // `isMutatingTool` is what WHAT FAILED consults, and it only ever has a name. It must not
    // claim a tool whose answer depends on arguments it cannot see.
    expect(isMutatingTool('str_replace_editor')).toBe(false);
    expect(isMutatingCall('str_replace_editor', { command: 'str_replace' })).toBe(true);
    expect(isMutatingCall('str_replace_editor', { command: 'view' })).toBe(false);
    expect(isMutatingCall('Write', {})).toBe(true);
  });

  it('anchors a Windows path instead of leaving it raw for the prefix test to miss', () => {
    // The transcript is data, and its separator is the data's. `p.startsWith('/')` is false for
    // `C:\…`, so the string fell through unresolved and then failed the repo-prefix test in
    // `buildState` — "Files touched" empty, on the line that has just called the tree dirty.
    const s = session(
      call('Edit', { file_path: 'C:\\repo\\src\\a.ts' }, undefined, 'C:\\repo'),
      call('Write', { file_path: 'src\\b.ts' }, undefined, 'C:\\repo'),
      call('Edit', { file_path: '.\\sub\\..\\c.ts' }, undefined, 'C:\\repo'),
    );
    expect(mutatedFiles(s)).toEqual(['C:\\repo\\src\\a.ts', 'C:\\repo\\src\\b.ts', 'C:\\repo\\c.ts']);
  });

  it('counts one Windows file once, however the transcript spelled it', () => {
    // Same over-count this module's docstring records fixing for `./sub/../a.ts`, arriving by the
    // other door: `C:\Repo\A.ts` and `c:\repo\a.ts` are ONE file there.
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
