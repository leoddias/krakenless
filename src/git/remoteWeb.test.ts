import { describe, expect, it } from 'vitest';
import { commitWebUrl, parseRemoteLocation } from './remoteWeb';

const OID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

describe('parseRemoteLocation', () => {
  it('reads an https remote', () => {
    expect(parseRemoteLocation('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('reads the scp-like ssh form', () => {
    expect(parseRemoteLocation('git@github.com:owner/repo.git')).toEqual({
      host: 'github.com',
      path: 'owner/repo',
    });
  });

  it('reads an ssh:// remote with a port', () => {
    expect(parseRemoteLocation('ssh://git@git.example.com:2222/team/repo.git')).toEqual({
      host: 'git.example.com',
      path: 'team/repo',
    });
  });

  it('keeps nested group paths whole', () => {
    expect(parseRemoteLocation('https://gitlab.com/group/sub/repo.git')?.path).toBe(
      'group/sub/repo',
    );
  });

  it('drops credentials from the authority', () => {
    expect(parseRemoteLocation('https://user:ghp_secret@github.com/o/r.git')).toEqual({
      host: 'github.com',
      path: 'o/r',
    });
  });

  it('keeps an IPv6 literal intact', () => {
    expect(parseRemoteLocation('ssh://git@[2001:db8::1]:22/o/r.git')?.host).toBe(
      '[2001:db8::1]',
    );
  });

  it.each([
    ['a Windows path', 'C:/repos/app'],
    ['a Windows path with backslashes', 'C:\\repos\\app'],
    ['a unix path', '/srv/git/app.git'],
    ['a relative path', '../sibling'],
    ['a file url', 'file:///srv/git/app.git'],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('has no web location for %s', (_label, url) => {
    expect(parseRemoteLocation(url)).toBeNull();
  });
});

describe('commitWebUrl', () => {
  it('builds a GitHub commit link', () => {
    expect(commitWebUrl('git@github.com:owner/repo.git', OID)).toBe(
      `https://github.com/owner/repo/commit/${OID}`,
    );
  });

  it('upgrades an ssh remote to https — the link is for a browser', () => {
    expect(commitWebUrl('ssh://git@gitlab.com/group/repo.git', OID)).toBe(
      `https://gitlab.com/group/repo/commit/${OID}`,
    );
  });

  it('uses the plural path Bitbucket Cloud serves commits under', () => {
    expect(commitWebUrl('https://bitbucket.org/team/repo.git', OID)).toBe(
      `https://bitbucket.org/team/repo/commits/${OID}`,
    );
  });

  it('never carries a token into the copied link', () => {
    const url = commitWebUrl('https://oauth2:ghp_secret@github.com/o/r.git', OID);
    expect(url).toBe(`https://github.com/o/r/commit/${OID}`);
    expect(url).not.toContain('ghp_secret');
  });

  it('lowercases the oid so two links to one commit are one string', () => {
    expect(commitWebUrl('https://github.com/o/r.git', OID.toUpperCase())).toBe(
      `https://github.com/o/r/commit/${OID}`,
    );
  });

  it.each([
    ['dev.azure.com', 'https://dev.azure.com/org/project/_git/repo'],
    ['visualstudio.com', 'https://org.visualstudio.com/project/_git/repo'],
  ])('refuses to guess for %s rather than produce a broken link', (_label, url) => {
    expect(commitWebUrl(url, OID)).toBeNull();
  });

  it('has no link for a local remote', () => {
    expect(commitWebUrl('C:/repos/app', OID)).toBeNull();
  });

  it.each([
    ['too short', 'abc'],
    ['not hex', 'zzzzzzz'],
    ['a ref name', 'HEAD'],
    ['a path traversal', '../../etc'],
  ])('refuses %s as a commit id', (_label, oid) => {
    expect(commitWebUrl('https://github.com/o/r.git', oid)).toBeNull();
  });
});
