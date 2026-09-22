// A handoff's name: a few words the saving agent chose for what the session was about, kept in the
// handoff's title so resume can list and load it by name. Handoffs saved before names go by their date.

/** `Ladder fix: live check!` -> `ladder-fix-live-check`. At most five words; empty when nothing usable is left. */
export function handoffName(raw: string): string {
  const words = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join('-').slice(0, 48).replace(/-+$/, '');
}

const NAME_LINE = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?name(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(.+)$/i;

/** The name line the agent starts its note with (looked for in its first five lines only), and the note without it. */
export function takeName(note: string): { name: string; rest: string } {
  const lines = note.split('\n');
  const k = lines.slice(0, 5).findIndex((l) => NAME_LINE.test(l));
  if (k < 0) return { name: '', rest: note };
  const name = handoffName(lines[k].match(NAME_LINE)![1]);
  return { name, rest: lines.filter((_, j) => j !== k).join('\n').trim() };
}

/** The name in a handoff's title, `# ladder-fix-live-check · project handoff · saved ...`. Older titles have none. */
export function nameInTitle(text: string): string | undefined {
  return text.match(/^# (\S+) · .* handoff · saved /m)?.[1];
}
