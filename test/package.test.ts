import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// What the published package declares about itself. It must never run code at install time, and it
// has no runtime dependencies at all.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;

describe('package.json', () => {
  it('names the licence, author, repository, issues, homepage and Node version', () => {
    expect(pkg.license).toBe('MIT');
    expect(pkg.author).toBe('Oliver Germer');
    expect(pkg.repository).toMatchObject({ url: expect.stringContaining('github.com/ogermer/swarmsay-cli') });
    expect(pkg.bugs).toContain('github.com/ogermer/swarmsay-cli/issues');
    expect(pkg.homepage).toBe('https://swarmsay.com');
    expect(pkg.engines).toEqual({ node: '>=20' });
  });

  it('has no install-time scripts', () => {
    const scripts = Object.keys((pkg.scripts as Record<string, string>) ?? {});
    for (const hook of [
      'preinstall',
      'install',
      'postinstall',
      'prepublish',
      'preprepare',
      'prepare',
      'postprepare',
    ]) {
      expect(scripts, hook).not.toContain(hook);
    }
  });

  it('has no runtime dependencies', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('stays private until publishing is released', () => {
    expect(pkg.private).toBe(true);
  });
});
