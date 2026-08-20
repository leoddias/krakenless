import { describe, expect, it } from 'vitest';
import { avatarFill, avatarHue, initials } from './avatar';

describe('initials', () => {
  it('takes the first and last name', () => {
    expect(initials('Leonardo Dias')).toBe('LD');
  });

  it('takes the first and last of three or more names', () => {
    expect(initials('Ada Byron King Lovelace')).toBe('AL');
  });

  it('uses one letter for a single name', () => {
    expect(initials('torvalds')).toBe('T');
  });

  it('splits the punctuation an account name uses instead of spaces', () => {
    expect(initials('ada.lovelace')).toBe('AL');
    expect(initials('ada-lovelace')).toBe('AL');
    expect(initials('ada_lovelace')).toBe('AL');
  });

  it('does not split an astral character in half', () => {
    // Naive `name[0]` returns half a surrogate pair, which renders as U+FFFD.
    expect(initials('𝒜da Lovelace')).toBe([...'𝒜'][0]?.toUpperCase() + 'L');
  });

  it('answers with a placeholder rather than an empty badge', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('avatarHue', () => {
  it('is stable for the same identity', () => {
    expect(avatarHue('ada@example.com', 'Ada')).toBe(avatarHue('ada@example.com', 'Ada'));
  });

  it('ignores the case and surrounding space of an email', () => {
    expect(avatarHue('  Ada@Example.com ', 'Ada')).toBe(
      avatarHue('ada@example.com', 'Ada'),
    );
  });

  it('keys on the email, so one person with two spellings keeps one colour', () => {
    expect(avatarHue('ada@example.com', 'Ada Lovelace')).toBe(
      avatarHue('ada@example.com', 'A. Lovelace'),
    );
  });

  it('separates two people who share a first name', () => {
    expect(avatarHue('alex.a@example.com', 'Alex')).not.toBe(
      avatarHue('alex.b@example.com', 'Alex'),
    );
  });

  it('falls back to the name when the commit carries no email', () => {
    expect(avatarHue('', 'Ada Lovelace')).toBe(avatarHue('', 'ada lovelace'));
    expect(avatarHue('', 'Ada')).not.toBe(avatarHue('', 'Grace'));
  });

  it('stays inside the hue circle', () => {
    for (const email of ['a@b.c', 'zzzz@qqq.dev', '', 'ünïcode@exämple.org']) {
      const hue = avatarHue(email, 'Someone');
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe('avatarFill', () => {
  it('is an hsl colour carrying the identity hue', () => {
    expect(avatarFill('ada@example.com', 'Ada')).toBe(
      `hsl(${avatarHue('ada@example.com', 'Ada')} 42% 38%)`,
    );
  });
});
