import { describe, expect, it } from 'vitest';
import { formatAbsoluteDate, formatRelativeDate } from './relativeTime';

const now = new Date('2026-08-20T12:00:00Z');

function ago(ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeDate', () => {
  it('calls anything under a minute "just now"', () => {
    expect(formatRelativeDate(ago(0), now)).toBe('just now');
    expect(formatRelativeDate(ago(59 * SECOND), now)).toBe('just now');
  });

  it('formats minutes and hours', () => {
    expect(formatRelativeDate(ago(MINUTE), now)).toBe('1 minute ago');
    expect(formatRelativeDate(ago(59 * MINUTE), now)).toBe('59 minutes ago');
    expect(formatRelativeDate(ago(HOUR), now)).toBe('1 hour ago');
    expect(formatRelativeDate(ago(90 * MINUTE), now)).toBe('1 hour ago');
    expect(formatRelativeDate(ago(23 * HOUR), now)).toBe('23 hours ago');
  });

  it('formats days, weeks, months and years', () => {
    expect(formatRelativeDate(ago(3 * DAY), now)).toBe('3 days ago');
    expect(formatRelativeDate(ago(6 * DAY), now)).toBe('6 days ago');
    expect(formatRelativeDate(ago(9 * DAY), now)).toBe('1 week ago');
    expect(formatRelativeDate(ago(21 * DAY), now)).toBe('3 weeks ago');
    expect(formatRelativeDate(ago(60 * DAY), now)).toBe('1 month ago');
    expect(formatRelativeDate(ago(200 * DAY), now)).toBe('6 months ago');
    expect(formatRelativeDate(ago(800 * DAY), now)).toBe('2 years ago');
  });

  it('handles dates in the future, which clock skew can produce', () => {
    expect(formatRelativeDate(ago(-2 * HOUR), now)).toBe('in 2 hours');
  });

  it('respects the timezone offset git reports', () => {
    // Same instant as 09:00Z, three hours before `now`.
    expect(formatRelativeDate('2026-08-20T06:00:00-03:00', now)).toBe('3 hours ago');
  });

  it('returns unparsable input verbatim instead of inventing a date', () => {
    expect(formatRelativeDate('not a date', now)).toBe('not a date');
    expect(formatAbsoluteDate('not a date')).toBe('not a date');
  });

  it('formats a parsable date for the tooltip', () => {
    expect(formatAbsoluteDate(now.toISOString())).toBe(now.toLocaleString());
  });
});
