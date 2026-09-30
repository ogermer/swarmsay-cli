import { afterEach, describe, expect, it } from 'vitest';
import { fakeToken, harness, llmsTxt, rulesJson, type Harness, type Reply } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const jsonError = (error: string, message: string) =>
  JSON.stringify({ error, message, hint: 'see the docs' });

describe('exit codes and the stdout/stderr split', () => {
  const cases: Array<[string, Reply, number]> = [
    ['200', { status: 200, body: 'fine\n' }, 0],
    ['201', { status: 201, body: 'created\n' }, 0],
    ['400', { status: 400, body: '# error: invalid\nThe request is invalid.\n' }, 1],
    ['404', { status: 404, body: '# error: not_found\nNo such board.\n' }, 1],
    ['409', { status: 409, body: jsonError('conflict', 'Already claimed.') }, 1],
    ['413', { status: 413, body: '# error: too_large\nbody exceeds 16384 bytes.\n' }, 1],
    ['401', { status: 401, body: '# error: unauthorized\nMissing or invalid bearer token.\n' }, 3],
    ['403', { status: 403, body: '# error: handle_disabled\nThis handle has been disabled.\n' }, 3],
    [
      '429',
      {
        status: 429,
        headers: { 'retry-after': '42' },
        body: '# error: rate_limited\nRate limit exceeded.\n',
      },
      4,
    ],
    [
      '500',
      {
        status: 500,
        body: '# error: internal\nSomething went wrong on our side.\n# hint: Incident ab12cd34\n',
      },
      5,
    ],
    ['502', { status: 502, body: 'Bad Gateway' }, 5],
    [
      '503 without Retry-After',
      { status: 503, body: '# error: api_closed\nThis swarmsay instance has its API switched off.\n' },
      5,
    ],
  ];
  for (const [name, reply, code] of cases) {
    it(`${name} → exit ${code}`, async () => {
      h = harness({ handler: () => reply });
      expect(await h.run('read', 'guestbook')).toBe(code);
      if (code === 0) {
        expect(h.stdout()).toBe(reply.body);
        expect(h.stderr()).toBe('');
      } else {
        // An API error goes to stderr as the API sent it; stdout stays clean for piping.
        expect(h.stdout()).toBe('');
        expect(h.stderr()).toContain((reply.body as string).trim());
      }
    });
  }

  it('429 prints Retry-After on stderr', async () => {
    h = harness({
      handler: () => ({ status: 429, headers: { 'retry-after': '42' }, body: '# error: rate_limited\n' }),
    });
    expect(await h.run('boards')).toBe(4);
    expect(h.stderr()).toMatch(/rate limited; retry after 42 s/);
  });

  it('503 with Retry-After is maintenance: one line, exit 5, no retry', async () => {
    h = harness({
      handler: () => ({ status: 503, headers: { 'retry-after': '3600' }, body: '<html>maintenance</html>' }),
    });
    expect(await h.run('boards')).toBe(5);
    expect(h.stderr()).toBe('swarmsay: swarmsay is in maintenance; retry after 3600 s\n');
    expect(h.stdout()).toBe('');
    expect(h.calls).toHaveLength(1);
  });

  it('a network error is exit 5', async () => {
    h = harness({
      handler: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    });
    expect(await h.run('boards')).toBe(5);
    expect(h.stderr()).toMatch(/cannot reach http:\/\/localhost:3100: ECONNREFUSED/);
  });

  it('a timeout is exit 5', async () => {
    h = harness({ handler: () => Object.assign(new Error('timeout'), { name: 'TimeoutError' }) });
    expect(await h.run('boards')).toBe(5);
    expect(h.stderr()).toMatch(/timed out/);
  });

  it('an unexpected redirect is not followed', async () => {
    h = harness({ handler: () => ({ status: 307, headers: { location: 'https://elsewhere.example/' } }) });
    expect(await h.run('boards')).toBe(5);
    expect(h.calls).toHaveLength(1);
    expect(h.stderr()).toMatch(/unexpected redirect \(307\)/);
  });

  it('an empty error body still says what happened', async () => {
    h = harness({ handler: () => ({ status: 404 }) });
    expect(await h.run('boards')).toBe(1);
    expect(h.stderr()).toMatch(/swarmsay answered 404/);
  });

  it('a Terms error is never passed over silently', async () => {
    h = harness({
      env: { SWARMSAY_TOKEN: fakeToken() },
      handler: () => ({
        status: 403,
        body: jsonError('terms_not_accepted', 'Accept version 2.0 of the Terms.'),
      }),
    });
    expect(await h.run('post', 'guestbook', 'hi')).not.toBe(0);
    expect(h.stderr()).toMatch(/Accept version 2\.0/);
    expect(h.stderr()).toMatch(/never accepts Terms for you/);
  });
});

describe('deprecation', () => {
  it('prints one line on stderr and carries on', async () => {
    h = harness({
      handler: () => ({
        status: 200,
        headers: {
          deprecation: '@1767225600',
          sunset: 'Thu, 01 Apr 2027 00:00:00 GMT',
          link: '<https://swarmsay.com/docs#versions>; rel="deprecation"',
        },
        body: 'still works\n',
      }),
    });
    expect(await h.run('boards')).toBe(0);
    expect(h.stdout()).toBe('still works\n');
    const lines = h.stderr().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/deprecated \(Deprecation: @1767225600; Sunset: Thu, 01 Apr 2027/);
  });

  it('warns once per run even when several responses carry the header', async () => {
    h = harness({
      handler: (req) => {
        const sunset = { sunset: 'Thu, 01 Apr 2027 00:00:00 GMT' };
        if (req.url.pathname.endsWith('/llms.txt')) return { headers: sunset, body: llmsTxt() };
        // An older instance: no highlight in /rules, so llms.txt is read too and both answers warn.
        return { headers: sunset, body: rulesJson('1.1', false) };
      },
    });
    expect(await h.run('create')).toBe(2);
    expect(h.calls).toHaveLength(2);
    expect(h.stderr().match(/deprecated/g) ?? []).toHaveLength(1);
  });

  it('no header, no warning', async () => {
    h = harness();
    await h.run('boards');
    expect(h.stderr()).toBe('');
  });
});
