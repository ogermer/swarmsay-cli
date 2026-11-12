import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, configPath } from '../src/config.js';
import { apiPath, fakeToken, harness, ORIGIN, type Harness, type HarnessOptions } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const EXPIRED_TXT = [
  '# error: key_expired',
  'This token has expired, but your handle @scout-7 can still be kept.',
  '# hint: POST /api/v1/claim {"method":"api_token"} with this token keeps it.',
  '',
].join('\n');
const EXPIRED_JSON = JSON.stringify({
  error: 'key_expired',
  message: 'This token has expired, but your handle @scout-7 can still be kept.',
  hint: 'POST /api/v1/claim {"method":"api_token"} with this token keeps it.',
});
const claimed = (token: string) =>
  `# swarmsay · claimed\nhandle:      scout-7\ntier:        self-claimed\ntoken:       ${token} (durable)\n`;

/** swarmsay with a remembered expired key: every route answers key_expired, except the claim. */
function expired(durable: string, opts: HarnessOptions = {}): Harness {
  return harness({
    ...opts,
    handler: (req) => {
      if (req.method === 'POST' && apiPath(req) === '/claim') return { status: 200, body: claimed(durable) };
      const json = (req.headers.accept ?? '').includes('json');
      return { status: 401, body: json ? EXPIRED_JSON : EXPIRED_TXT };
    },
  });
}
const store = () => new ConfigStore(configPath(h.io.env, h.home));
const storeEphemeral = (token: string) => store().put(ORIGIN, 'scout-7', token, 'ephemeral', true);
const sent = (path: string) => h.calls.filter((c) => apiPath(c) === path);

describe('a command refused with key_expired', () => {
  it('on a terminal, offers the claim; yes claims with the saved token and stores the durable one', async () => {
    const [old, durable] = [fakeToken(), fakeToken()];
    h = expired(durable, { tty: true, answers: ['y'] });
    storeEphemeral(old);
    expect(await h.run('post', 'guestbook', 'hello')).toBe(3);
    expect(h.stderr()).toContain('This token has expired, but your handle @scout-7 can still be kept.');
    expect(h.stderr()).toContain('Keep this handle now? This runs `swarmsay claim` with your saved token.');
    const claim = sent('/claim');
    expect(claim).toHaveLength(1);
    expect(claim[0]!.headers.authorization).toBe(`Bearer ${old}`);
    expect(JSON.parse(claim[0]!.body!)).toEqual({ method: 'api_token' });
    expect(store().get(ORIGIN, undefined)).toMatchObject({ handle: { token: durable, kind: 'durable' } });
    expect(h.stderr()).toMatch(/Run your command again\./);
    // The refused post is not repeated, and neither token is printed.
    expect(h.calls.filter((c) => c.method === 'POST' && apiPath(c) !== '/claim')).toHaveLength(1);
    expect(h.stdout() + h.stderr()).not.toContain(old);
    expect(h.stdout() + h.stderr()).not.toContain(durable);
  });

  for (const answer of ['n', '', 'no']) {
    it(`answer ${JSON.stringify(answer)} claims nothing and keeps the old token`, async () => {
      const old = fakeToken();
      h = expired(fakeToken(), { tty: true, answers: [answer] });
      storeEphemeral(old);
      expect(await h.run('whoami')).toBe(3);
      expect(sent('/claim')).toHaveLength(0);
      expect(store().get(ORIGIN, undefined)).toMatchObject({ handle: { token: old, kind: 'ephemeral' } });
      expect(h.stderr()).toMatch(/Nothing was claimed\. To keep the handle later: swarmsay claim/);
    });
  }

  it('without a terminal: no prompt, no claim, exit 3 with the server error and the hint line', async () => {
    h = expired(fakeToken());
    storeEphemeral(fakeToken());
    expect(await h.run('whoami')).toBe(3);
    expect(sent('/claim')).toHaveLength(0);
    expect(h.stderr()).toContain('# error: key_expired');
    expect(h.stderr()).toMatch(/^Run: swarmsay claim$/m);
  });

  it('with --json, even on a terminal: passes the body through and adds nothing', async () => {
    h = expired(fakeToken(), { tty: true });
    storeEphemeral(fakeToken());
    expect(await h.run('whoami', '--json')).toBe(3);
    expect(sent('/claim')).toHaveLength(0);
    expect(h.stderr().trim()).toBe(EXPIRED_JSON);
    expect(h.stdout()).toBe('');
  });

  it('with a token from SWARMSAY_TOKEN (nothing saved to replace): names the command, does not prompt', async () => {
    h = expired(fakeToken(), { tty: true, env: { SWARMSAY_TOKEN: fakeToken() } });
    expect(await h.run('whoami')).toBe(3);
    expect(sent('/claim')).toHaveLength(0);
    expect(h.stderr()).toMatch(/^Run: swarmsay claim$/m);
  });
});

describe('swarmsay claim with an expired saved token', () => {
  it('sends it as the bearer and stores the durable token', async () => {
    const [old, durable] = [fakeToken(), fakeToken()];
    h = expired(durable);
    storeEphemeral(old);
    expect(await h.run('claim')).toBe(0);
    expect(sent('/claim')[0]!.headers.authorization).toBe(`Bearer ${old}`);
    expect(store().get(ORIGIN, undefined)).toMatchObject({ handle: { token: durable, kind: 'durable' } });
  });
});
