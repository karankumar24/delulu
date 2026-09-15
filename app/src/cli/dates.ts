// Times as people read them: a date and a wall-clock time, never a folder stamp. Built by hand so no
// locale changes the words.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2:05 PM` */
export const clock = (d: Date): string => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;

/** `Thu Sep 11 at 6:30 PM` */
export const clockNow = (d: Date): string => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} at ${clock(d)}`;

/** `Tue Sep 15, 2026 at 12:22 AM` */
export const fullDate = (d: Date): string => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${clock(d)}`;

/** `Sep 15, 4:24 PM`, or nothing when the timestamp is missing or unreadable. */
export function shortTime(iso?: string): string {
  const d = iso ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock(d)}` : '';
}

export interface StampWhen { day: string; age: string; time: string }

/**
 * A folder stamp read as local time, the way it was written: `{ day: 'Aug 20', age: '6 days ago', time: '3:48 AM' }`.
 * Null when it is not a real date, since `new Date` rolls an impossible one over instead of failing.
 */
export function stampWhen(stamp: string, now: Date): StampWhen | null {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const when = new Date(y, mo - 1, d, h, mi, s);
  if (when.getFullYear() !== y || when.getMonth() !== mo - 1 || when.getDate() !== d) return null;
  const day = `${MONTHS[mo - 1]} ${d}${y === now.getFullYear() ? '' : ` ${y}`}`;
  // Calendar days, not elapsed hours: 11pm last night is "yesterday" at 9am.
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(when)) / 86_400_000);
  const age = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return { day, age, time: clock(when) };
}

/** What a handoff is called in front of a person: its date, or the stamp itself when that is not a date. */
export function handoffLabel(stamp: string, now: Date): string {
  const when = stampWhen(stamp, now);
  return when ? `${when.day} handoff` : stamp;
}
