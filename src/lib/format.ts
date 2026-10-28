// Display formatting shared by every page. Dates are YYYY-MM-DD strings in UTC; "today" is
// the day the data was generated, since the site is rebuilt daily.

const DAY = 86_400_000;
const parseDay = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** 842 → "842", 1234 → "1.2k", 36_812 → "36.8k", 509_747 → "510k", 1_234_567 → "1.2M". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const [value, unit] = n < 999_500 ? [n / 1000, 'k'] : [n / 1_000_000, 'M'];
  const rounded = value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded}${unit}`;
}

/** 1234567 → "1,234,567". */
export const fullNumber = (n: number) => n.toLocaleString('en-US');

/** 0.426 → "↑ 43%", −0.12 → "↓ 12%", 0.004 → "0%". */
export function trendLabel(change: number): string {
  const pct = Math.round(Math.abs(change) * 100);
  if (pct === 0) return '0%';
  return `${change > 0 ? '↑' : '↓'} ${fullNumber(pct)}%`;
}

export const daysAgo = (date: string, today: string) =>
  Math.round((parseDay(today) - parseDay(date)) / DAY);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "8 Oct 2026", or "8 Oct" when `withYear` is false. */
export function shortDate(date: string, withYear = true): string {
  const d = new Date(parseDay(date));
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${day} ${d.getUTCFullYear()}` : day;
}

/** "today", "yesterday", a weekday within the last week, then "8 Oct". */
export function relativeDay(date: string, today: string): string {
  const days = daysAgo(date, today);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return WEEKDAYS[new Date(parseDay(date)).getUTCDay()];
  return shortDate(date, date.slice(0, 4) !== today.slice(0, 4));
}

/** "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago", "over a year ago". */
export function agoLabel(date: string, today: string): string {
  const days = daysAgo(date, today);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return 'over a year ago';
}
