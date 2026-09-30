import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeToken, harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const sentBody = () => JSON.parse(h.calls[0]!.body!).body as string;

// Awkward bodies: quotes, backslashes, control characters, JSON-lookalikes, emoji, RTL and combining marks.
const TRICKY = [
  'plain',
  'quotes " and \' and `backticks` and $HOME and $(rm -rf /)',
  'back\\slash \\n not a newline',
  'tab\there, bell\u0007, escape\u001b[31m, nul\u0000 end',
  'line one\nline two\r\nline three',
  '{"body":"injected"}',
  'Grüße, 日本語, emoji 🐝🧭, RTL עברית, combining é',
  ' line separator paragraph separator',
];

describe('bodies', () => {
  for (const body of TRICKY) {
    it(`from an argument: ${JSON.stringify(body).slice(0, 40)}`, async () => {
      h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
      expect(await h.run('post', 'guestbook', body)).toBe(0);
      expect(sentBody()).toBe(body);
    });

    it(`from stdin: ${JSON.stringify(body).slice(0, 40)}`, async () => {
      h = harness({ env: { SWARMSAY_TOKEN: fakeToken() }, stdin: body + '\n' });
      expect(await h.run('send', 'scout-7', '-')).toBe(0);
      expect(sentBody()).toBe(body);
    });

    it(`from a file: ${JSON.stringify(body).slice(0, 40)}`, async () => {
      h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
      const file = join(h.home, 'body.txt');
      writeFileSync(file, body);
      expect(await h.run('post', 'guestbook', '--file', file)).toBe(0);
      expect(sentBody()).toBe(body);
    });
  }

  it('drops exactly one trailing newline from stdin', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() }, stdin: 'two\n\n' });
    await h.run('post', 'guestbook', '-');
    expect(sentBody()).toBe('two\n');
  });

  it('drops one trailing CRLF from a file', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
    const file = join(h.home, 'b.txt');
    writeFileSync(file, 'windows\r\n');
    await h.run('post', 'guestbook', '--file', file);
    expect(sentBody()).toBe('windows');
  });

  it('keeps a body argument exactly, trailing newline included', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
    await h.run('post', 'guestbook', 'keep\n');
    expect(sentBody()).toBe('keep\n');
  });

  it('an empty body is a usage error', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() }, stdin: '\n' });
    expect(await h.run('post', 'guestbook', '-')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('an argument and --file together is a usage error', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
    expect(await h.run('post', 'guestbook', 'x', '--file', '/nonexistent')).toBe(2);
  });

  it('a missing file is a usage error', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
    expect(await h.run('post', 'guestbook', '--file', join(h.home, 'missing.txt'))).toBe(2);
    expect(h.stderr()).toMatch(/ENOENT/);
  });

  it('the body is sent as JSON, UTF-8', async () => {
    h = harness({ env: { SWARMSAY_TOKEN: fakeToken() } });
    await h.run('post', 'guestbook', 'Grüße 🐝');
    expect(h.calls[0]!.body).toBe('{"body":"Grüße 🐝"}');
  });
});
