// The files an agent changed, read from its own tool calls, never from what it said.

import { homedir } from 'node:os';
import { absolutePath, sameFileKey } from './path-shape';
import type { ParsedSession } from './tail';

// CC: NotebookEdit (notebook_path). Cursor: EditNotebook/edit_notebook (target_notebook).
const MUTATING_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'editnotebook']);

/** Anthropic's text-editor tools write or only view depending on `command`. */
const EDITOR_TOOLS = new Set(['str_replace_editor', 'str_replace_based_edit_tool']);
const EDITOR_WRITES = new Set(['create', 'str_replace', 'insert', 'undo_edit']);

/** MCP filesystem servers' write and edit tools. */
const MCP_MUTATING = /(?:^|__)(?:write|edit|create)_(?:file|notebook)$/i;

function isMutatingCall(name: string, input: Record<string, unknown>): boolean {
  const n = name.toLowerCase();
  if (MUTATING_TOOLS.has(n) || MCP_MUTATING.test(n)) return true;
  return EDITOR_TOOLS.has(n) && typeof input.command === 'string' && EDITOR_WRITES.has(input.command);
}

/** Path field(s) used by file-mutating tools (Write/Edit/NotebookEdit, etc.). */
function mutatingToolPath(input: Record<string, unknown>): string | undefined {
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.target_notebook === 'string') return input.target_notebook;
  if (typeof input.notebook_path === 'string') return input.notebook_path;
  return undefined;
}

/**
 * The distinct files the agent changed, in first-touch order. A call whose result failed or was
 * refused does not count; one with no result yet does. Paths are resolved against the call's cwd,
 * so one file is never listed twice.
 */
export function mutatedFiles(session: ParsedSession): string[] {
  // toolUseId -> did it succeed. Absent means no result was recorded at all.
  const outcome = new Map<string, boolean>();
  for (const ev of session.events) {
    if (ev.kind === 'tool-result' && ev.toolUseId) outcome.set(ev.toolUseId, ev.ok !== false);
  }

  // Keyed by the file, holding the first spelling seen.
  const seen = new Map<string, string>();
  for (const ev of session.events) {
    if (ev.kind !== 'tool') continue;
    if (!isMutatingCall(ev.toolName ?? '', ev.toolInput ?? {})) continue;
    if (ev.toolUseId && outcome.get(ev.toolUseId) === false) continue; // rejected or errored
    const p = mutatingToolPath(ev.toolInput ?? {});
    if (!p) continue;
    // With nothing to anchor it, a relative path stays raw rather than resolving against delulu's own cwd.
    const abs = absolutePath(p, ev.cwd, homedir()) ?? p;
    const key = sameFileKey(abs);
    if (!seen.has(key)) seen.set(key, abs);
  }
  return [...seen.values()];
}
