// delulu engine — the files an agent actually mutated.
//
// Ground truth of what the agent DID, read from its OWN tool calls (a Write/Edit
// tool_use names the file it touched). Prose is never consulted here, so a
// paraphrase or an unfinished promise can't add a file to this set.

import { homedir } from 'node:os';
import { absolutePath, sameFileKey } from './path-shape';
import type { ParsedSession } from './tail';

// CC: NotebookEdit (notebook_path). Cursor: EditNotebook/edit_notebook (target_notebook).
const MUTATING_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'editnotebook']);

/**
 * Anthropic's text-editor tools, which are mutating or not depending on their ARGUMENTS.
 *
 * `str_replace_editor` and `str_replace_based_edit_tool` take a required `command` of
 * `view | create | str_replace | insert | undo_edit`. Only four of those five write anything. They
 * were briefly added to `MUTATING_TOOLS` above, which decides on the NAME alone — so a plain `view`
 * was reported under "Files touched via Write/Edit" for a file the session only read: a false
 * statement in the block that says it was read from the real repo, on a line whose own text says
 * "via Write/Edit". Undercounting is the safe direction here and overcounting is not, which is why
 * the name-only predicate must not claim them.
 */
const EDITOR_TOOLS = new Set(['str_replace_editor', 'str_replace_based_edit_tool']);
const EDITOR_WRITES = new Set(['create', 'str_replace', 'insert', 'undo_edit']);

/**
 * MCP filesystem servers expose the same capability under their own names
 * (`mcp__filesystem__write_file`, `…__edit_file`). Matching only the exact built-in names meant a
 * file written through one of those never appeared in "Files touched" at all.
 */
const MCP_MUTATING = /(?:^|__)(?:write|edit|create)_(?:file|notebook)$/i;

export function isMutatingTool(name: string): boolean {
  const n = name.toLowerCase();
  return MUTATING_TOOLS.has(n) || MCP_MUTATING.test(n);
}

/**
 * Did this CALL mutate a file? The name where the name is enough, the arguments where it is not.
 *
 * Kept separate from `isMutatingTool` rather than replacing it: callers that only ever see a tool
 * NAME (WHAT FAILED reads one out of a transcript line) cannot answer the argument-dependent case,
 * and a predicate that silently guessed for them is how a read became a write.
 */
export function isMutatingCall(name: string, input: Record<string, unknown>): boolean {
  if (isMutatingTool(name)) return true;
  return EDITOR_TOOLS.has(name.toLowerCase()) && typeof input.command === 'string' && EDITOR_WRITES.has(input.command);
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
 * The DISTINCT set of files the agent mutated, in first-touch order. Subagent
 * (isSidechain) turns are filtered upstream by the parser unless the caller opts in.
 *
 * Two rules, both learned from this block printing things that were not true:
 *
 * 1. A CALL IS NOT A MUTATION. The tool's RESULT decides. A Write the user REJECTED, or an Edit
 *    that errored ("File has not been read yet"), used to be reported as a file the agent touched —
 *    while WHAT FAILED, three lines below in the same payload, reported the very same call as an
 *    error. The user-refusal case is the worst of it: the next session reads "Files touched:
 *    never-written.ts" for a change the user explicitly blocked. A call with NO result is still
 *    counted — in-flight is not evidence of failure, and erring toward naming a file is the safe
 *    direction here.
 *
 * 2. PATHS ARE RESOLVED, not compared as raw strings. `./sub/../a.ts` and `/repo/a.ts` are one
 *    file; counting them twice inflated the total, and a relative path additionally failed the
 *    repo-prefix test downstream and disappeared from the block. Resolution uses the cwd recorded
 *    on the tool call itself, which is what the path was written relative to.
 *
 * 3. THE SEPARATOR IS THE TRANSCRIPT'S, NOT THIS MACHINE'S. This line read `p.startsWith('/')` and
 *    `resolve(ev.cwd ?? '/', p)` — a POSIX root for an anchor. `C:\repo\a.ts` starts with no '/',
 *    fell through to the raw string, and then failed the repo-prefix test in `buildState`, so the
 *    whole block was empty on Windows while the tree was dirty. `absolutePath` decides the flavour
 *    from the strings themselves; see `path-shape.ts` for what that is and is not verified to do.
 */
export function mutatedFiles(session: ParsedSession): string[] {
  // toolUseId -> did it succeed. Absent means no result was recorded at all.
  const outcome = new Map<string, boolean>();
  for (const ev of session.events) {
    if (ev.kind === 'tool-result' && ev.toolUseId) outcome.set(ev.toolUseId, ev.ok !== false);
  }

  // Keyed by the file, valued by the FIRST spelling seen, because on Windows `C:\Repo\A.ts` and
  // `c:\repo\a.ts` are one file and a plain Set counted them as two.
  const seen = new Map<string, string>();
  for (const ev of session.events) {
    if (ev.kind !== 'tool') continue;
    if (!isMutatingCall(ev.toolName ?? '', ev.toolInput ?? {})) continue;
    if (ev.toolUseId && outcome.get(ev.toolUseId) === false) continue; // rejected or errored
    const p = mutatingToolPath(ev.toolInput ?? {});
    if (!p) continue;
    // With no cwd and nothing absolute about the string we keep it raw, rather than anchoring to
    // delulu's own process directory, which would invent a path the agent never touched.
    const abs = absolutePath(p, ev.cwd, homedir()) ?? p;
    const key = sameFileKey(abs);
    if (!seen.has(key)) seen.set(key, abs);
  }
  return [...seen.values()];
}
