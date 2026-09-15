// Reading untyped transcript records.
export type Rec = Record<string, unknown>;

export const obj = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The text blocks of a message content or a queued prompt, joined. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (obj(b)?.type === 'text' ? str(obj(b)?.text) : '')).filter(Boolean).join('\n\n');
}
