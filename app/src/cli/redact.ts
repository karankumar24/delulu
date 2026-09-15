// Keys and addresses hidden from everything delulu writes. Hide first, then shorten, so a cut can
// never leave part of a key behind.
const SECRETS = new RegExp([
  '\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}',
  '\\bsk_(?:live|test)_[A-Za-z0-9]{16,}',
  '\\bsb_secret_[A-Za-z0-9_-]{16,}',
  '\\bgh[pousr]_[A-Za-z0-9]{20,}',
  '\\bgithub_pat_[A-Za-z0-9_]{20,}',
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
  '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
  '\\bAIza[A-Za-z0-9_-]{30,}',
  '\\bya29\\.[A-Za-z0-9_-]{20,}',
  'https://(?:hooks\\.slack\\.com/services|discord(?:app)?\\.com/api/webhooks)/[A-Za-z0-9/_-]+',
  // A long name_token mixing case and digits, except id prefixes that are not secrets.
  '\\b(?!(?:req|trig|cse|dpl|env|msg|toolu)_)[A-Za-z][A-Za-z0-9]{2,}_(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{24,}\\b',
  '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
  'Bearer\\s+[A-Za-z0-9._~+/=-]{20,}',
  '-----BEGIN[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----)?',
  '\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s:@/]+:[^\\s/]{4,}@',
].join('|'), 'g');

/** A value assigned to a secret-sounding name, when the value mixes letters and digits. */
const ASSIGNED = /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|_KEY|APIKEY)[A-Za-z0-9_]*\s*[=:]\s*(?=[^\s,]*[A-Za-z])(?=[^\s,]*[0-9])[^\s,]{12,}/gi;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.([A-Za-z]{2,})\b/g;
const FILE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'py', 'css', 'html', 'yml', 'yaml', 'sh']);

/** Keeps the user's own address and the ones they typed themselves; hides every other one. */
export function makeRedactor(o: { ownEmail?: string; typedEmails?: string[] } = {}): (t: string) => string {
  const keep = new Set([o.ownEmail ?? '', ...(o.typedEmails ?? [])].map((e) => e.trim().toLowerCase()).filter(Boolean));
  return (t) => t.replace(SECRETS, '[redacted-secret]').replace(ASSIGNED, '[redacted-secret]')
    .replace(EMAIL, (m: string, tld: string, at: number, all: string) =>
      keep.has(m.toLowerCase()) || FILE_EXT.has(tld.toLowerCase()) || all[at - 1] === '/' ? m : '[redacted-email]');
}

/** Redacts, then shortens to `n` characters (never splitting a character in two). */
export function clipText(t: string, n: number, redact: (t: string) => string): string {
  const chars = Array.from(redact(t));
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
}
