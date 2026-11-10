/** Owner-local (America/Los_Angeles) calendar date as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
