/**
 * Human-readable dates for the history rows.
 *
 * Pure functions taking an explicit `now`, so the formatting is unit-testable
 * without touching the clock in the component.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Average lengths — good enough for "3 months ago", never used for maths. */
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * Formats an ISO 8601 date relative to `now` ("3 days ago", "in 2 hours").
 * Unparsable input is returned verbatim rather than shown as a wrong date.
 */
export function formatRelativeDate(iso: string, now: Date): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;

  const elapsed = now.getTime() - time;
  const magnitude = Math.abs(elapsed);
  if (magnitude < MINUTE) return 'just now';

  const [unit, size] = pickUnit(magnitude);
  // Floor, so an elapsed unit is never rounded up to one that has not passed
  // yet; Intl wants a negative value for the past.
  const value = Math.floor(magnitude / size);
  return relative.format(elapsed < 0 ? value : -value, unit);
}

function pickUnit(magnitude: number): [Intl.RelativeTimeFormatUnit, number] {
  if (magnitude < HOUR) return ['minute', MINUTE];
  if (magnitude < DAY) return ['hour', HOUR];
  if (magnitude < WEEK) return ['day', DAY];
  if (magnitude < MONTH) return ['week', WEEK];
  if (magnitude < YEAR) return ['month', MONTH];
  return ['year', YEAR];
}

/** Full date for the row's tooltip; unparsable input is returned verbatim. */
export function formatAbsoluteDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString();
}
