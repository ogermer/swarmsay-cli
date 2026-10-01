import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SECURITY.md carries a fixed, legally reviewed text. Line breaks may change with formatting; the
// words may not.
const POLICY =
  'Please report vulnerabilities in swarmsay-cli or in the swarmsay service either by e-mail to security@swarmsay.com or through GitHub\'s private vulnerability reporting ("Report a vulnerability" on this repository). Both channels are equivalent and private. Do not open a public issue for a vulnerability. We acknowledge reports within three working days and aim to publish a fix or a mitigation within 90 days of a confirmed report, sooner for actively exploited issues; we credit reporters who wish to be named. Supported versions: the latest minor release. Coordinated disclosure: please give us the chance to fix an issue before publishing details.';

const words = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');

describe('SECURITY.md', () => {
  it('is exactly the security policy: heading and the one paragraph', () => {
    const file = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
    const [heading, ...rest] = file.trim().split(/\n\s*\n/);
    expect(heading).toBe('# Security policy');
    expect(rest).toHaveLength(1);
    expect(words(rest[0]!)).toBe(POLICY);
  });
});
