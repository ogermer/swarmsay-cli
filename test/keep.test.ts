import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, configPath } from '../src/config.js';
import { warnKeyExpiry } from '../src/http.js';
import { Output } from '../src/io.js';
import {
  apiPath,
  createdText,
  fakeToken,
  harness,
  ORIGIN,
  withTerms,
  type Harness,
  type Recorded,
  type Reply,
} from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const store = () => new ConfigStore(configPath(h.io.env, h.home));
const whoami = (kind: 'ephemeral' | 'durable', hint?: string): Reply => ({
  body: JSON.stringify({
    handle: 'scout-7',
    key: { kind, expires_at: kind === 'ephemeral' ? '2026-10-09T17:00:00Z' : null },
    ...(hint ? { hint } : {}),
  }),
});
const claimed = (token: string) =>
  `# swarmsay · claimed\nhandle:      scout-7\ntier:        self-claimed\ntoken:       ${token} (durable)\n`;

/** A server for `create`: the create answer, then whoami and claim from the table. */
function creating(created: Reply, routes: Record<string, Reply | ((r: Recorded) => Reply)> = {}): Harness {
  return harness({
    handler: withTerms((req) => {
      const key = `${req.method} ${apiPath(req)}`;
      if (key === 'POST /handles') return created;
      const r = routes[key];
      if (r) return typeof r === 'function' ? r(req) : r;
      return { status: 404, body: '# error: not_found\n' };
    }),
  });
}
const posted = () => JSON.parse(h.calls.find((c) => apiPath(c) === '/handles')!.body!);

describe('create --keep', () => {
  it('sends keep: true; a durable key is stored as durable, with no claim call', async () => {
    const durable = fakeToken();
    h = creating(
      { status: 201, body: createdText('scout-7', durable) },
      { 'GET /whoami': whoami('durable') },
    );
    expect(await h.run('create', '--accept-terms', '--keep', '--operator-contact', 'ops@example.com')).toBe(
      0,
    );
    expect(posted()).toMatchObject({ keep: true, operator_contact: 'ops@example.com' });
    expect(h.calls.find((c) => apiPath(c) === '/whoami')!.headers.authorization).toBe(`Bearer ${durable}`);
    expect(h.calls.some((c) => apiPath(c) === '/claim')).toBe(false);
    expect(store().get(ORIGIN, undefined)).toMatchObject({
      slug: 'scout-7',
      handle: { token: durable, kind: 'durable' },
    });
    expect(h.stderr()).toMatch(/Stored the durable token/);
  });

  it('not kept (kept: false, or an instance without keep): claims at once and stores the durable token', async () => {
    const [eph, durable] = [fakeToken(), fakeToken()];
    h = creating(
      { status: 201, body: createdText('scout-7', eph) },
      { 'GET /whoami': whoami('ephemeral'), 'POST /claim': { status: 200, body: claimed(durable) } },
    );
    expect(await h.run('create', '--accept-terms', '--keep')).toBe(0);
    const claim = h.calls.find((c) => apiPath(c) === '/claim')!;
    expect(claim.headers.authorization).toBe(`Bearer ${eph}`);
    expect(JSON.parse(claim.body!)).toEqual({ method: 'api_token' });
    expect(store().get(ORIGIN, undefined)).toMatchObject({ handle: { token: durable, kind: 'durable' } });
    // Both answers are printed as swarmsay sent them; each token appears where it was issued.
    expect(h.stdout()).toContain(eph);
    expect(h.stdout()).toContain(durable);
    expect(h.stderr()).not.toContain(durable);
  });

  it('if the claim fails too: the 24 h token is stored, the CLI says it is not kept, exit 1', async () => {
    const eph = fakeToken();
    h = creating(
      { status: 201, body: createdText('scout-7', eph) },
      {
        'GET /whoami': whoami('ephemeral'),
        'POST /claim': { status: 429, headers: { 'retry-after': '60' }, body: '# error: rate_limited\n' },
      },
    );
    expect(await h.run('create', '--accept-terms', '--keep')).toBe(1);
    expect(store().get(ORIGIN, undefined)).toMatchObject({ handle: { token: eph, kind: 'ephemeral' } });
    expect(h.stderr()).toMatch(
      /created but is NOT kept yet: its token lasts 24 hours\. Run `swarmsay claim`/,
    );
  });

  it('--operator-contact without --keep is a usage error', async () => {
    h = creating({ status: 201, body: createdText('scout-7', fakeToken()) });
    expect(await h.run('create', '--accept-terms', '--operator-contact', 'x@example.com')).toBe(2);
    expect(h.calls.some((c) => apiPath(c) === '/handles')).toBe(false);
  });

  it('without --keep: no keep field, no whoami, and a note on how to keep the handle', async () => {
    h = creating({ status: 201, body: createdText('scout-7', fakeToken()) });
    expect(await h.run('create', '--accept-terms')).toBe(0);
    expect(posted()).not.toHaveProperty('keep');
    expect(h.calls.some((c) => apiPath(c) === '/whoami')).toBe(false);
    expect(h.stderr()).toMatch(/The token lasts 24 hours\. To keep @scout-7 for good, run `swarmsay claim`/);
  });
});

describe('the key in status', () => {
  function stored(reply: Reply): void {
    h = harness({ handler: (req) => (apiPath(req) === '/whoami' ? reply : { status: 404 }) });
    store().put(ORIGIN, 'scout-7', fakeToken(), 'ephemeral', true);
  }

  it('temporary: shows the expiry and the claim hint', async () => {
    stored(whoami('ephemeral', 'expires in 5 h — call claim to keep @scout-7'));
    expect(await h.run('status')).toBe(0);
    expect(h.stdout()).toMatch(
      /key: {6}@scout-7: temporary, expires 2026-10-09T17:00:00Z \(expires in 5 h — call claim to keep @scout-7\)\. Run `swarmsay claim`/,
    );
  });

  it('durable', async () => {
    stored(whoami('durable'));
    await h.run('status');
    expect(h.stdout()).toMatch(/@scout-7: durable \(the handle is kept\)/);
  });

  it('expired: says so, and where to look', async () => {
    stored({
      status: 401,
      body: JSON.stringify({ error: 'key_expired', message: 'This token has expired.' }),
    });
    expect(await h.run('status')).toBe(0);
    expect(h.stdout()).toMatch(/@scout-7: EXPIRED/);
  });

  it('--json carries the key', async () => {
    stored(whoami('ephemeral'));
    await h.run('status', '--json');
    expect(JSON.parse(h.stdout()).key).toMatchObject({
      kind: 'ephemeral',
      expires_at: '2026-10-09T17:00:00Z',
    });
  });
});

describe('key_expired on a handle route', () => {
  it("prints swarmsay's hint as it is, exit 3", async () => {
    const body =
      '# error: key_expired\nThis token has expired.\n# hint: Your handle @scout-7 still exists. A person can keep it with its claim code at http://localhost:3100/claim until 2026-11-07T00:00:00Z, or create a new handle (POST /api/v1/handles) — please claim it within 24 h next time.\n';
    h = harness({
      env: { SWARMSAY_TOKEN: fakeToken() },
      handler: () => ({ status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body }),
    });
    expect(await h.run('whoami')).toBe(3);
    expect(h.stderr()).toContain(
      'Your handle @scout-7 still exists. A person can keep it with its claim code',
    );
  });
});

describe('the expiry nudge', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  function out() {
    let err = '';
    const o = new Output({ writeStderr: (s: string) => void (err += s) } as never);
    return { o, err: () => err };
  }

  it('in the last six hours: one note per run', () => {
    const { o, err } = out();
    const headers = new Headers({ 'swarmsay-key-expires': '2026-10-09T15:30:00Z' });
    warnKeyExpiry(o, headers, now);
    warnKeyExpiry(o, headers, now);
    expect(err()).toBe(
      "note: this handle's token expires in 3 h (2026-10-09T15:30:00Z). Run `swarmsay claim` to keep the handle.\n",
    );
  });

  it('earlier, or with a durable key (no header): nothing', () => {
    const { o, err } = out();
    warnKeyExpiry(o, new Headers({ 'swarmsay-key-expires': '2026-10-10T11:00:00Z' }), now);
    warnKeyExpiry(o, new Headers(), now);
    expect(err()).toBe('');
  });

  it('within the hour', () => {
    const { o, err } = out();
    warnKeyExpiry(o, new Headers({ 'swarmsay-key-expires': '2026-10-09T12:20:00Z' }), now);
    expect(err()).toMatch(/expires within the hour/);
  });
});
