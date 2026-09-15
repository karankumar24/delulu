// Standing rules carried from one handoff to the next. The agent's note may add a rule, or drop one with
// a reason; a previous rule that disappears from its list without a reason is put back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Note { summary: string; rulesGiven: boolean; rules: string[]; dropped: string[] }

const HEADS: Record<string, 'rules' | 'dropped'> = { 'standing rules': 'rules', 'dropped rules': 'dropped' };

/** The agent's note: its summary, and the rule lists when it wrote them. A rules section holds only bullets. */
export function parseNote(text: string): Note {
  const summary: string[] = [];
  const lists = { rules: [] as string[], dropped: [] as string[] };
  let into: 'rules' | 'dropped' | undefined;
  let rulesGiven = false;
  for (const line of text.split('\n')) {
    const head = HEADS[line.match(/^##\s+(.+?)\s*$/)?.[1]?.toLowerCase() ?? ''];
    if (head) { into = head; rulesGiven ||= head === 'rules'; continue; }
    if (into && line.startsWith('- ')) { lists[into].push(line.trimEnd()); continue; }
    if (into && !line.trim()) continue;
    into = undefined;
    summary.push(line);
  }
  return { summary: summary.join('\n').replace(/\n{3,}/g, '\n\n').trim(), rulesGiven, rules: lists.rules, dropped: lists.dropped };
}

/** The opening words of a rule, without bullet, quote, ref or reason: enough to recognise it again. */
function core(line: string): string {
  const c = line.replace(/^-\s*/, '').replace(/Dropped because:.*$/i, '').replace(/[`"“(].*$/, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
  return c || line.toLowerCase();
}
const same = (a: string, b: string) => core(a).startsWith(core(b)) || core(b).startsWith(core(a));

/** The rules this handoff carries. Nothing leaves without a reason the agent wrote down. */
export function mergeRules(previous: string[], note: Note): { rules: string[]; restored: string[]; dropped: string[] } {
  const dropped = (rule: string) => note.dropped.some((d) => same(d, rule));
  if (!note.rulesGiven) return { rules: previous.filter((r) => !dropped(r)), restored: [], dropped: note.dropped };
  const restored = previous.filter((r) => !note.rules.some((k) => same(k, r)) && !dropped(r));
  return { rules: [...note.rules, ...restored], restored, dropped: note.dropped };
}

/** The standing rules of the newest earlier handoff; none when there is no earlier handoff or it had none. */
export function previousRules(base: string, folder: string | undefined): string[] {
  if (!folder) return [];
  let text: string;
  try { text = readFileSync(join(base, folder, 'handoff.md'), 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === '## Standing rules');
  if (start === -1) return [];
  const end = lines.findIndex((l, k) => k > start && l.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((l) => l.startsWith('- ')).map((l) => l.trimEnd());
}
