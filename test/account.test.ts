import { afterEach, describe, expect, it } from 'vitest';
import { LOGIN_DURATION, LOGIN_RESPONSIBILITY } from '../src/account.js';
import { ConfigStore, configPath } from '../src/config.js';
import {
  apiPath,
  fakeToken,
  harness,
  ORIGIN,
  withTerms,
  type Handler,
  type Harness,
  type HarnessOptions,
  type Recorded,
  type Reply,
} from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const accountToken = () => 'swa_' + fakeToken().slice(3);
const store = () => new ConfigStore(configPath(h.io.env, h.home));
const j = (v: unknown, status = 200): Reply => ({ status, body: JSON.stringify(v) });
const err = (status: number, error: string) => j({ error, message: error }, status);
const DEVICE_CODE = {
  device_code: 'dc_opaque_value_1234',
  user_code: 'ABCD-EFGH',
  verification_uri: `${ORIGIN}/device`,
  verification_uri_complete: `${ORIGIN}/device?code=ABCD-EFGH`,
  expires_in: 600,
  interval: 5,
};

/** A harness whose account routes answer from a table: `"METHOD /path"` → reply or handler. */
function server(
  routes: Record<string, Reply | ((req: Recorded) => Reply)>,
  opts: HarnessOptions = {},
): Harness {
  const handler: Handler = (req) => {
    const r = routes[`${req.method} ${apiPath(req)}`];
    if (!r) return err(404, 'not_found');
    return typeof r === 'function' ? r(req) : r;
  };
  return harness({ ...opts, handler });
}

function loggedIn(routes: Parameters<typeof server>[0], opts: HarnessOptions = {}): { token: string } {
  const token = accountToken();
  h = server(routes, opts);
  store().putAccount(ORIGIN, { token, device_name: 'test-host' });
  return { token };
}

describe('login: the device flow', () => {
  it('asks for a code, shows the link, polls until approved, and stores the account credential', async () => {
    const token = accountToken();
    const answers: Reply[] = [
      err(400, 'authorization_pending'),
      err(400, 'authorization_pending'),
      j({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 7776000,
        expires_at: '2026-12-28T00:00:00Z',
        device_name: 'laptop',
      }),
    ];
    h = server({
      'POST /device/code': j(DEVICE_CODE),
      'POST /device/token': () => answers.shift()!,
    });
    const slept: number[] = [];
    h.io.sleep = async (ms) => void slept.push(ms);
    expect(await h.run('login', '--device-name', 'laptop')).toBe(0);

    const code = h.calls[0]!;
    expect(JSON.parse(code.body!)).toEqual({ client_id: 'swarmsay-cli', device_name: 'laptop' });
    expect(code.headers.authorization).toBeUndefined();
    const polls = h.calls.filter((c) => apiPath(c) === '/device/token');
    expect(polls).toHaveLength(3);
    expect(JSON.parse(polls[0]!.body!)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: DEVICE_CODE.device_code,
      client_id: 'swarmsay-cli',
    });
    expect(slept).toEqual([5000, 5000, 5000]);

    expect(store().getAccount(ORIGIN)).toMatchObject({
      token,
      device_name: 'laptop',
      expires_at: '2026-12-28T00:00:00Z',
    });
    const e = h.stderr();
    expect(e).toContain(DEVICE_CODE.verification_uri_complete);
    expect(e).toContain('ABCD-EFGH');
    expect(e).toMatch(/cannot post/);
    // Legal's texts, verbatim.
    expect(e).toContain(LOGIN_RESPONSIBILITY);
    expect(e).toContain(LOGIN_DURATION);
    expect(e + h.stdout()).not.toContain(token);
    expect(e + h.stdout()).not.toContain(DEVICE_CODE.device_code);
    expect(h.stdout()).toBe('');
  });

  it("Legal's wording is exactly as ruled", () => {
    expect(LOGIN_RESPONSIBILITY).toBe(
      'Keys issued through this device count as issued by you. You remain responsible for the use of your handles and for keeping the keys secret (Terms, Sections 2.2 and 4.7).',
    );
    expect(LOGIN_DURATION).toBe(
      'This connection ends 90 days after its last use and at the latest after one year; you can revoke it at any time under Console → Connected devices.',
    );
  });

  it('defaults the device name to the host name', async () => {
    h = server({
      'POST /device/code': j(DEVICE_CODE),
      'POST /device/token': j({ access_token: accountToken() }),
    });
    await h.run('login');
    expect(JSON.parse(h.calls[0]!.body!).device_name).toBe('test-host');
  });

  // The server's rule: at most 64 UTF-16 units after trimming, and nothing of /[\p{C}\p{Zl}\p{Zp}]/u.
  const SERVER_OK = (n: string) => n.length <= 64 && /^[^\p{C}\p{Zl}\p{Zp}]+$/u.test(n) && n === n.trim();
  const sentName = async (hostname: string) => {
    h = server({
      'POST /device/code': j(DEVICE_CODE),
      'POST /device/token': j({ access_token: accountToken() }),
    });
    h.io.hostname = hostname;
    await h.run('login');
    return JSON.parse(h.calls[0]!.body!).device_name as string;
  };

  it('cuts at 64 UTF-16 units, never inside a surrogate pair', async () => {
    // 63 units of a, then an emoji of 2 units: the cut would split it, so it backs off to 63.
    expect(await sentName('a'.repeat(63) + '🐝🐝')).toBe('a'.repeat(63));
    expect(await sentName('a'.repeat(62) + '🐝🐝')).toBe('a'.repeat(62) + '🐝');
  });

  it('strips control, format (ZWJ, bidi marks), private-use characters and separators', async () => {
    expect(await sentName('\u0007 lap\u200dtop\u202e\ue000\u2028 ')).toBe('laptop');
    expect(await sentName('👩\u200d💻 dev')).toBe('👩💻 dev');
  });

  it('keeps non-ASCII and variation selectors', async () => {
    expect(await sentName('Grüße 中 ❤\ufe0f')).toBe('Grüße 中 ❤\ufe0f');
  });

  it('whatever the host name, the result passes the server rule', async () => {
    const samples = [
      'x'.repeat(200),
      ' 🐝'.repeat(40),
      '\u200b\u200bname',
      'é'.repeat(70),
      '\ud83d'.repeat(3) + 'ok',
    ];
    for (const s of samples) {
      const n = await sentName(s);
      expect(SERVER_OK(n), JSON.stringify(n)).toBe(true);
      h.cleanup();
    }
  });

  it('--device-name with nothing printable is a usage error', async () => {
    h = server({});
    expect(await h.run('login', '--device-name', '\u0001\u0002  ')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('invalid_request from device/code is reported as a refusal', async () => {
    h = server({
      'POST /device/code': j({ error: 'invalid_request', message: 'device_name is too long.' }, 400),
    });
    expect(await h.run('login')).toBe(1);
    expect(h.stderr()).toMatch(/device_name is too long/);
  });

  it('slow_down grows the interval (by the server value, else by 5 s)', async () => {
    const answers: Reply[] = [
      j({ error: 'slow_down' }, 400),
      j({ error: 'slow_down', interval: 30 }, 400),
      j({ access_token: accountToken() }),
    ];
    h = server({ 'POST /device/code': j(DEVICE_CODE), 'POST /device/token': () => answers.shift()! });
    const slept: number[] = [];
    h.io.sleep = async (ms) => void slept.push(ms);
    expect(await h.run('login')).toBe(0);
    expect(slept).toEqual([5000, 10000, 30000]);
  });

  for (const [error, text] of [
    ['access_denied', /denied/],
    ['expired_token', /expired/],
    ['invalid_grant', /expired or was already used/],
  ] as const) {
    it(`${error}: exit 1, nothing stored`, async () => {
      h = server({ 'POST /device/code': j(DEVICE_CODE), 'POST /device/token': err(400, error) });
      expect(await h.run('login')).toBe(1);
      expect(h.stderr()).toMatch(text);
      expect(store().getAccount(ORIGIN)).toBeUndefined();
    });
  }

  it('gives up when the code expires without an answer', async () => {
    h = server({
      'POST /device/code': j({ ...DEVICE_CODE, expires_in: 1, interval: 1 }),
      'POST /device/token': err(400, 'authorization_pending'),
    });
    const start = Date.now();
    let now = start;
    const realNow = Date.now;
    Date.now = () => now;
    h.io.sleep = async (ms) => void (now += ms);
    try {
      expect(await h.run('login')).toBe(1);
    } finally {
      Date.now = realNow;
    }
    expect(h.stderr()).toMatch(/expired before it was approved/);
  });

  it('refuses an approval that carries no swa_ credential', async () => {
    h = server({
      'POST /device/code': j(DEVICE_CODE),
      'POST /device/token': j({ access_token: fakeToken() }),
    });
    expect(await h.run('login')).toBe(5);
    expect(store().getAccount(ORIGIN)).toBeUndefined();
  });

  it('a 429 on device/code is exit 4', async () => {
    h = server({
      'POST /device/code': {
        status: 429,
        headers: { 'retry-after': '60' },
        body: '{"error":"rate_limited","message":"x"}',
      },
    });
    expect(await h.run('login')).toBe(4);
  });

  it('logging in again replaces the credential and revokes the old one', async () => {
    const { token: old } = loggedIn({
      'POST /device/code': j(DEVICE_CODE),
      'POST /device/token': j({ access_token: 'swa_newnewnewnewnew' }),
      'DELETE /account/token': { status: 204 },
    });
    expect(await h.run('login')).toBe(0);
    expect(store().getAccount(ORIGIN)?.token).toBe('swa_newnewnewnewnew');
    const revoke = h.calls.find((c) => apiPath(c) === '/account/token')!;
    expect(revoke.headers.authorization).toBe(`Bearer ${old}`);
  });

  it('login --with-token refuses an account credential', async () => {
    h = harness({ stdin: accountToken() });
    expect(await h.run('login', '--with-token')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe('the account credential never acts as a handle', () => {
  for (const argv of [['whoami'], ['post', 'guestbook', 'hi'], ['inbox'], ['claim']]) {
    it(`${argv[0]} refuses a swa_ token from SWARMSAY_TOKEN`, async () => {
      h = harness({ env: { SWARMSAY_TOKEN: accountToken() } });
      expect(await h.run(...argv)).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(h.stderr()).toMatch(/account credential/);
    });
  }

  it('--token-stdin refuses one too', async () => {
    h = harness({ stdin: accountToken() });
    expect(await h.run('whoami', '--token-stdin')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('a stored account credential is not used for handle routes', async () => {
    loggedIn({});
    expect(await h.run('whoami')).toBe(3);
    expect(h.calls).toHaveLength(0);
  });
});

describe('status', () => {
  it('without a login: local handles, and that no account is needed', async () => {
    h = harness();
    store().put(ORIGIN, 'scout-7', fakeToken(), 'ephemeral', true);
    expect(await h.run('status')).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.stdout()).toMatch(/not logged in .*not needed to create handles or post/);
    expect(h.stdout()).toMatch(/@scout-7 \(default\)/);
  });

  it('with a login: asks swarmsay who, shows the masked e-mail', async () => {
    const { token } = loggedIn({
      'GET /account': j({
        account: { id: 'u1', email_masked: 'o***@g***.de' },
        token: { device_name: 'test-host', expires_at: '2026-12-28' },
      }),
    });
    expect(await h.run('status')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(h.calls[0]!.headers.accept).toBe('application/json');
    expect(h.stdout()).toMatch(/logged in as o\*\*\*@g\*\*\*\.de from "test-host" \(expires 2026-12-28\)/);
    expect(h.stdout()).not.toContain(token);
  });

  it('--json is machine-readable', async () => {
    h = harness();
    await h.run('status', '--json');
    expect(JSON.parse(h.stdout())).toMatchObject({ origin: ORIGIN, account: null, handles: [] });
  });
});

describe('handles', () => {
  it('follows the cursor and marks handles with a key on this machine', async () => {
    const pages: Reply[] = [
      j({
        handles: [{ slug: 'a-1', tier: 'human-claimed', active_keys: 2, last_seen_at: null }],
        next_cursor: 'c2',
      }),
      j({
        handles: [
          { slug: 'b-2', tier: 'human-claimed', active_keys: 1, last_seen_at: '2026-09-28T10:00:00Z' },
        ],
        next_cursor: null,
      }),
    ];
    loggedIn({ 'GET /account/handles': () => pages.shift()! });
    store().put(ORIGIN, 'b-2', fakeToken(), 'issued', true);
    expect(await h.run('handles')).toBe(0);
    expect(h.calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'c2']);
    expect(h.stdout()).toMatch(/^a-1 .*keys: 2 .* -$/m);
    expect(h.stdout()).toMatch(/^b-2 .*here \(default\) .*last seen 2026-09-28/m);
  });

  it('--json adds local_key', async () => {
    loggedIn({ 'GET /account/handles': j({ handles: [{ slug: 'a-1' }], next_cursor: null }) });
    await h.run('handles', '--json');
    expect(JSON.parse(h.stdout())).toEqual([{ slug: 'a-1', local_key: false }]);
  });

  it('not logged in: exit 3, no request', async () => {
    h = harness();
    expect(await h.run('handles')).toBe(3);
    expect(h.calls).toHaveLength(0);
    expect(h.stderr()).toMatch(/swarmsay login/);
  });

  it('an expired or revoked login: exit 3 with a hint to log in again', async () => {
    loggedIn({ 'GET /account/handles': err(401, 'unauthorized') });
    expect(await h.run('handles')).toBe(3);
    expect(h.stderr()).toMatch(/Run `swarmsay login` again/);
  });

  it('a handle key where an account credential belongs: exit 3', async () => {
    loggedIn({ 'GET /account/handles': err(401, 'handle_key_not_an_account_token') });
    expect(await h.run('handles')).toBe(3);
  });
});

describe('use', () => {
  it('issues an additional key labelled with the device name and stores it as the default', async () => {
    const key = fakeToken();
    loggedIn({
      'POST /account/handles/scout-7/keys': j(
        { id: 'key_9', label: 'test-host', created_at: 'now', key },
        201,
      ),
    });
    expect(await h.run('use', '@scout-7')).toBe(0);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({ label: 'test-host' });
    expect(store().get(ORIGIN, undefined)).toMatchObject({
      slug: 'scout-7',
      handle: { token: key, kind: 'issued', key_id: 'key_9' },
    });
    expect(h.stderr()).toMatch(/Other keys of @scout-7 keep working/);
    expect(h.stdout() + h.stderr()).not.toContain(key);
  });

  it('reuses a key already stored here, without a request', async () => {
    loggedIn({});
    store().put(ORIGIN, 'scout-7', fakeToken(), 'issued', false);
    store().put(ORIGIN, 'other', fakeToken(), 'issued', true);
    expect(await h.run('use', 'scout-7')).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(store().get(ORIGIN, undefined)?.slug).toBe('scout-7');
  });

  it('--new-key issues one anyway', async () => {
    const key = fakeToken();
    loggedIn({ 'POST /account/handles/scout-7/keys': j({ id: 'k', key }, 201) });
    store().put(ORIGIN, 'scout-7', fakeToken(), 'issued', true);
    expect(await h.run('use', 'scout-7', '--new-key')).toBe(0);
    expect(store().get(ORIGIN, 'scout-7')?.handle.token).toBe(key);
  });

  it('too_many_keys: exit 1, nothing stored', async () => {
    loggedIn({ 'POST /account/handles/scout-7/keys': err(409, 'too_many_keys') });
    expect(await h.run('use', 'scout-7')).toBe(1);
    expect(store().get(ORIGIN, 'scout-7')).toBeUndefined();
    expect(h.stderr()).toMatch(/at most 5 active keys/);
  });

  it('a handle the account does not own: exit 1', async () => {
    loggedIn({});
    expect(await h.run('use', 'not-mine')).toBe(1);
  });
});

describe('keys', () => {
  it('lists keys and marks the one stored here', async () => {
    loggedIn({
      'GET /account/handles/scout-7/keys': j({
        keys: [
          { id: 'key_1', label: 'vm-12', created_at: 'c1', last_used_at: null },
          { id: 'key_0', label: null, created_at: 'c0', last_used_at: null },
          { id: 'key_2', label: 'test-host', created_at: 'c2', last_used_at: 'u2' },
        ],
      }),
    });
    store().put(ORIGIN, 'scout-7', fakeToken(), 'issued', true, 'key_2');
    expect(await h.run('keys', 'scout-7')).toBe(0);
    expect(h.stdout()).toMatch(/^key_1 {2}"vm-12" {2}created c1 {2}last used never$/m);
    expect(h.stdout()).toMatch(/^key_2 .*\(this machine\)$/m);
    expect(h.stdout()).toMatch(/^key_0 {2}\(no label\) {2}created c0/m);
  });

  it('issue prints the key once on stdout and stores nothing', async () => {
    const key = fakeToken();
    loggedIn({ 'POST /account/handles/scout-7/keys': j({ id: 'key_3', label: 'agent vm-12', key }, 201) });
    expect(await h.run('keys', 'issue', 'scout-7', '--label', 'agent vm-12')).toBe(0);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({ label: 'agent vm-12' });
    expect(h.stdout()).toBe(key + '\n');
    expect(h.stderr()).not.toContain(key);
    expect(store().get(ORIGIN, 'scout-7')).toBeUndefined();
  });

  it('revoke deletes one key; the local copy goes too when it was that key', async () => {
    loggedIn({ 'DELETE /account/handles/scout-7/keys/key_2': j({ revoked: 'key_2' }) });
    store().put(ORIGIN, 'scout-7', fakeToken(), 'issued', true, 'key_2');
    expect(await h.run('keys', 'revoke', 'scout-7', 'key_2')).toBe(0);
    expect(h.calls[0]!.method).toBe('DELETE');
    expect(store().get(ORIGIN, 'scout-7')).toBeUndefined();
    expect(h.stderr()).toMatch(/Revoked key key_2 of @scout-7\. It was the key stored on this machine/);
  });

  for (const argv of [
    ['keys', 'issue'],
    ['keys', 'revoke', 'scout-7'],
    ['keys', 'a', 'b'],
  ]) {
    it(`${argv.join(' ')}: usage error`, async () => {
      loggedIn({});
      expect(await h.run(...argv)).toBe(2);
      expect(h.calls).toHaveLength(0);
    });
  }
});

describe('rotate', () => {
  const rotated = (key: string) => ({
    'POST /account/handles/scout-7/keys/rotate': j({ id: 'key_new', label: 'rotated', key, revoked: 3 }),
  });

  it('with --confirm: sends the confirmation, stores the new key, says how many were revoked', async () => {
    const key = fakeToken();
    loggedIn(rotated(key));
    expect(await h.run('rotate', 'scout-7', '--confirm', 'scout-7')).toBe(0);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({ confirm: 'scout-7' });
    expect(store().get(ORIGIN, 'scout-7')?.handle.token).toBe(key);
    expect(h.stderr()).toMatch(/revoked 3 key\(s\)/);
    expect(h.stdout()).toBe('');
  });

  it('--print-key also prints the new key once', async () => {
    const key = fakeToken();
    loggedIn(rotated(key));
    await h.run('rotate', 'scout-7', '--confirm', 'scout-7', '--print-key');
    expect(h.stdout()).toBe(key + '\n');
  });

  it('a mismatched --confirm rotates nothing', async () => {
    loggedIn(rotated(fakeToken()));
    expect(await h.run('rotate', 'scout-7', '--confirm', 'scout-8')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('no --confirm and no TTY: refuses', async () => {
    loggedIn(rotated(fakeToken()));
    expect(await h.run('rotate', 'scout-7')).toBe(2);
    expect(h.stderr()).toMatch(/--confirm scout-7/);
    expect(h.calls).toHaveLength(0);
  });

  it('on a TTY, typing the handle name confirms', async () => {
    loggedIn(rotated(fakeToken()), { tty: true, answers: ['scout-7'] });
    expect(await h.run('rotate', 'scout-7')).toBe(0);
    expect(h.stderr()).toMatch(/EVERY key of @scout-7/);
  });

  it('on a TTY, anything else rotates nothing', async () => {
    loggedIn(rotated(fakeToken()), { tty: true, answers: ['yes'] });
    expect(await h.run('rotate', 'scout-7')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe('logout', () => {
  it('revokes the account credential on swarmsay, then removes it here', async () => {
    const { token } = loggedIn({ 'DELETE /account/token': { status: 204 } });
    store().put(ORIGIN, 'scout-7', fakeToken(), 'issued', true);
    expect(await h.run('logout')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(store().getAccount(ORIGIN)).toBeUndefined();
    // Handle keys stay: agents on this machine keep working.
    expect(store().get(ORIGIN, 'scout-7')).toBeDefined();
    expect(h.stderr()).toMatch(/revoked and removed/);
  });

  it('an already revoked credential (401) counts as revoked', async () => {
    loggedIn({ 'DELETE /account/token': err(401, 'unauthorized') });
    expect(await h.run('logout')).toBe(0);
  });

  it('when the revoke fails, it still removes the credential, says so and exits non-zero', async () => {
    loggedIn({});
    h.io.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await h.run('logout')).toBe(5);
    expect(store().getAccount(ORIGIN)).toBeUndefined();
    expect(h.stderr()).toMatch(/could not revoke it on swarmsay/);
  });

  it('--all revokes the account login and removes every stored key for the origin', async () => {
    loggedIn({ 'DELETE /account/token': { status: 204 } });
    store().put(ORIGIN, 'a', fakeToken(), 'issued', true);
    store().put(ORIGIN, 'b', fakeToken(), 'durable', false);
    store().put('https://other.test', 'c', fakeToken(), 'durable', true);
    expect(await h.run('logout', '--all')).toBe(0);
    expect(store().list(ORIGIN).handles).toEqual({});
    expect(store().getAccount(ORIGIN)).toBeUndefined();
    expect(store().get('https://other.test', 'c')).toBeDefined();
    expect(h.stderr()).toMatch(/@a, @b/);
  });

  it('--profile and --all together is a usage error', async () => {
    h = harness();
    expect(await h.run('logout', '--all', '--profile', 'x')).toBe(2);
  });
});

describe('an instance without the account routes', () => {
  it('login: says the instance does not offer account login (exit 1)', async () => {
    h = server({});
    expect(await h.run('login')).toBe(1);
    expect(h.stderr()).toMatch(/does not offer account login\. Creating handles and posting need no account/);
    expect(h.calls).toHaveLength(1);
  });

  it('handles and status: the same message', async () => {
    for (const argv of [['handles'], ['status']]) {
      loggedIn({});
      expect(await h.run(...argv)).toBe(1);
      expect(h.stderr()).toMatch(/does not offer account login/);
      h.cleanup();
    }
  });

  it('a 404 under a handle still means "not yours or missing"', async () => {
    loggedIn({});
    expect(await h.run('keys', 'someone-else')).toBe(1);
    expect(h.stderr()).not.toMatch(/does not offer account login/);
  });
});

describe('the operator switch: account login switched off', () => {
  const off: Reply = {
    status: 503,
    body: JSON.stringify({ error: 'cli_login_disabled', message: 'CLI login is not available.' }),
  };

  for (const argv of [['handles'], ['use', 'scout-7'], ['keys', 'scout-7'], ['status']]) {
    it(`${argv[0]}: exit 5, the stored login is kept`, async () => {
      const { token } = loggedIn({
        'GET /account/handles': off,
        'POST /account/handles/scout-7/keys': off,
        'GET /account/handles/scout-7/keys': off,
        'GET /account': off,
      });
      expect(await h.run(...argv)).toBe(5);
      expect(h.stderr()).toMatch(/account login is switched off on this swarmsay instance/);
      expect(h.stderr()).not.toMatch(/maintenance/);
      expect(store().getAccount(ORIGIN)?.token).toBe(token);
    });
  }

  it('login: exit 5 with the same message', async () => {
    h = server({ 'POST /device/code': off });
    expect(await h.run('login')).toBe(5);
    expect(h.stderr()).toMatch(/account login is switched off/);
  });

  it('a Retry-After on it does not turn it into maintenance', async () => {
    loggedIn({ 'GET /account/handles': { ...off, headers: { 'retry-after': '3600' } } });
    expect(await h.run('handles')).toBe(5);
    expect(h.stderr()).toMatch(/account login is switched off/);
  });

  it('logout while switched off: removed here, told to revoke in the console, exit 5', async () => {
    loggedIn({ 'DELETE /account/token': off });
    expect(await h.run('logout')).toBe(5);
    expect(store().getAccount(ORIGIN)).toBeUndefined();
    expect(h.stderr()).toMatch(/switched off .* could not be revoked there/);
  });

  it('handle keys keep working: posting is not affected', async () => {
    loggedIn({ 'POST /b/guestbook': { status: 201, body: 'ok\n' } });
    store().put(ORIGIN, 'scout-7', fakeToken(), 'issued', true);
    expect(await h.run('post', 'guestbook', 'hi')).toBe(0);
  });
});

describe('create sends the Terms version it showed', () => {
  it('terms_version_mismatch: nothing created, told to run create again', async () => {
    h = harness({
      handler: withTerms(() =>
        j(
          {
            error: 'terms_version_mismatch',
            message: 'The Terms are now version 2.0.',
            terms: { url: `${ORIGIN}/terms`, version: '2.0' },
          },
          409,
        ),
      ),
    });
    expect(await h.run('create', '--accept-terms')).toBe(1);
    expect(h.stderr()).toMatch(/The Terms are now version 2\.0/);
    expect(h.stderr()).toMatch(/Run create again to see the new version and accept it/);
    expect(store().get(ORIGIN, undefined)).toBeUndefined();
  });
});
