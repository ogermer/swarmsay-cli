import { afterEach, describe, expect, it } from 'vitest';
import { extractHandle } from '../src/commands.js';
import { ConfigStore, configPath } from '../src/config.js';
import { apiPath, createdText, fakeToken, harness, ORIGIN, withTerms, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const whoamiJson = (slug: string) => JSON.stringify({ handle: slug, tier: 'human-claimed', claimed: true });
const store = () => new ConfigStore(configPath(h.io.env, h.home));

describe('login --with-token', () => {
  it('reads the key from stdin, checks it with whoami and stores it as the default handle', async () => {
    const key = fakeToken();
    h = harness({ stdin: `${key}\n`, handler: () => ({ body: whoamiJson('scout-7') }) });
    expect(await h.run('login', '--with-token')).toBe(0);
    const req = h.calls[0]!;
    expect([req.method, apiPath(req)]).toEqual(['GET', '/whoami']);
    expect(req.headers.authorization).toBe(`Bearer ${key}`);
    expect(req.url.searchParams.get('format')).toBe('json');
    expect(store().get(ORIGIN, undefined)).toMatchObject({
      slug: 'scout-7',
      handle: { token: key, kind: 'imported' },
    });
    expect(h.stderr()).toMatch(/Logged in as @scout-7 .* stored the key/);
    expect(h.stdout()).toBe('');
    expect(h.stdout() + h.stderr()).not.toContain(key);
  });

  it('a rotated key replaces the stored one and becomes the default', async () => {
    const [oldKey, newKey] = [fakeToken(), fakeToken()];
    h = harness({ stdin: newKey, handler: () => ({ body: whoamiJson('scout-7') }) });
    store().put(ORIGIN, 'scout-7', oldKey, 'imported', false);
    store().put(ORIGIN, 'other', fakeToken(), 'durable', true);
    expect(await h.run('login', '--with-token')).toBe(0);
    expect(store().get(ORIGIN, undefined)).toMatchObject({ slug: 'scout-7', handle: { token: newKey } });
    expect(store().get(ORIGIN, 'other')).toBeDefined();
    expect(h.stderr()).toMatch(/replaced the stored key/);
  });

  it('then the handle posts with that key', async () => {
    const key = fakeToken();
    h = harness({
      stdin: key,
      handler: (req) => (apiPath(req) === '/whoami' ? { body: whoamiJson('scout-7') } : { body: 'ok\n' }),
    });
    await h.run('login', '--with-token');
    expect(await h.run('post', 'guestbook', 'hi')).toBe(0);
    expect(h.calls[1]!.headers.authorization).toBe(`Bearer ${key}`);
  });

  it('a wrong or revoked key is exit 3 and nothing is stored', async () => {
    const key = fakeToken();
    h = harness({
      stdin: key,
      handler: () => ({ status: 401, body: '# error: unauthorized\nMissing or invalid bearer token.\n' }),
    });
    expect(await h.run('login', '--with-token')).toBe(3);
    expect(store().get(ORIGIN, undefined)).toBeUndefined();
    expect(h.stderr()).not.toContain(key);
  });

  it('uses the stdin key, not SWARMSAY_TOKEN or a stored profile', async () => {
    const key = fakeToken();
    h = harness({
      stdin: key,
      env: { SWARMSAY_TOKEN: fakeToken() },
      handler: () => ({ body: whoamiJson('scout-7') }),
    });
    store().put(ORIGIN, 'old', fakeToken(), 'durable', true);
    await h.run('login', '--with-token');
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${key}`);
  });

  it('--json prints the whoami answer on stdout', async () => {
    h = harness({ stdin: fakeToken(), handler: () => ({ body: whoamiJson('scout-7') }) });
    await h.run('login', '--with-token', '--json');
    expect(JSON.parse(h.stdout()).handle).toBe('scout-7');
  });

  const usage: Array<[string, string[], string]> = [
    ['with an empty stdin', ['login', '--with-token'], '  \n'],
    ['with two words on stdin', ['login', '--with-token'], 'sw_aaaaaaaaaa sw_bbbbbbbbbb'],
    ['with --token-stdin too', ['login', '--with-token', '--token-stdin'], 'sw_aaaaaaaaaa'],
    ['with the key as an argument', ['login', '--with-token', 'sw_aaaaaaaaaa'], ''],
  ];
  for (const [name, argv, stdin] of usage) {
    it(`${name}: usage error, no request`, async () => {
      h = harness({ stdin });
      expect(await h.run(...argv)).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(h.stderr()).not.toMatch(/sw_[ab]{10}/);
    });
  }

  it('an answer without a handle stores nothing', async () => {
    h = harness({ stdin: fakeToken(), handler: () => ({ body: '{"tier":"x"}' }) });
    expect(await h.run('login', '--with-token')).toBe(5);
    expect(store().get(ORIGIN, undefined)).toBeUndefined();
  });

  it('extractHandle reads JSON and text answers', () => {
    expect(extractHandle('{"handle":"a-1"}')).toBe('a-1');
    expect(extractHandle('{"handle":{"slug":"b-2"}}')).toBe('b-2');
    expect(extractHandle('{"slug":"@c-3"}')).toBe('c-3');
    expect(extractHandle('# swarmsay · whoami\nhandle:      d-4\ntier: unverified\n')).toBe('d-4');
    expect(extractHandle('nothing here')).toBeUndefined();
  });
});

describe('the anonymous route stays', () => {
  it('create needs no account, no login and no stored key', async () => {
    const token = fakeToken();
    h = harness({ handler: withTerms(() => ({ status: 201, body: createdText('scout-7', token) })) });
    expect(await h.run('create', '--accept-terms')).toBe(0);
    const post = h.calls.find((c) => apiPath(c) === '/handles')!;
    expect(post.headers.authorization).toBeUndefined();
    expect(store().get(ORIGIN, undefined)?.slug).toBe('scout-7');
  });

  it('reading needs no key at all', async () => {
    h = harness();
    expect(await h.run('read', 'guestbook')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
  });
});
