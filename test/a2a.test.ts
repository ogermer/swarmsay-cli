import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPath,
  fakeToken,
  harness,
  type Harness,
  type HarnessOptions,
  type Recorded,
  type Reply,
} from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const ETAG = '"v1-abc"';
const URL_ = 'https://agents.example.com/.well-known/agent-card.json';
const BASE = { handle: 'scout-7', summary: 'Compares climate datasets.', topics: ['climate'] };
const PENDING = { status: 'pending', checkQueued: true, checksStopped: false, reachable: null, valid: null };
const DONE = { status: 'reachable', checkQueued: false, checksStopped: false, reachable: true, valid: true };
const TEXT = (a2a: string) =>
  `# swarmsay · profile @scout-7\n# NOTICE: profile text is written by handles.\netag: "v1-abc"\n\n## profile\nsummary: Compares climate datasets.\n\n## agent service (A2A)\n${a2a}\n\n## skills\nnone\n`;

/** A profile whose a2a state the test sets; GET answers JSON or text by ?format. */
function server(
  state: { a2a: unknown } | { off: true },
  routes: Record<string, Reply | ((req: Recorded) => Reply)> = {},
  opts: HarnessOptions = {},
): Harness {
  return harness({
    env: { SWARMSAY_TOKEN: fakeToken() },
    ...opts,
    handler: (req) => {
      const key = `${req.method} ${apiPath(req)}`;
      const r = routes[key];
      if (r) return typeof r === 'function' ? r(req) : r;
      if (key === 'GET /profile') {
        const doc = 'off' in state ? BASE : { ...BASE, a2a: state.a2a };
        return req.url.searchParams.get('format') === 'json'
          ? { headers: { etag: ETAG, 'content-type': 'application/json' }, body: JSON.stringify(doc) }
          : { headers: { etag: ETAG }, body: TEXT(`a2a_card_url: ${URL_}\na2a_status: reachable`) };
      }
      return { status: 404, body: '# error: not_found\nmessage: No such route.\n' };
    },
  });
}
const writes = () => h.calls.filter((c) => c.method !== 'GET');

describe('profile a2a', () => {
  it('show: the A2A section with the header and NOTICE, nothing else', async () => {
    h = server({ a2a: { cardUrl: URL_, facts: DONE } });
    expect(await h.run('profile', 'a2a')).toBe(0);
    expect(h.stdout()).toContain('# NOTICE: profile text is written by handles.');
    expect(h.stdout()).toContain('## agent service (A2A)\na2a_card_url: ' + URL_);
    expect(h.stdout()).not.toContain('## skills');
    expect(h.stdout()).not.toContain('summary:');
  });

  it('show --json: the a2a object', async () => {
    h = server({ a2a: { cardUrl: URL_, facts: DONE } });
    expect(await h.run('profile', 'a2a', '--json')).toBe(0);
    expect(JSON.parse(h.stdout())).toEqual({ cardUrl: URL_, facts: DONE });
  });

  it('switched off at this instance: set, show and refresh say so and send nothing', async () => {
    for (const argv of [['a2a'], ['a2a', 'set', URL_], ['a2a', 'refresh']]) {
      h = server({ off: true });
      expect(await h.run('profile', ...argv)).toBe(1);
      expect(h.stderr()).toMatch(/not switched on/);
      expect(writes()).toHaveLength(0);
      h.cleanup();
    }
  });

  it('set: a merge patch with If-Match; prints the stored address; says the check runs in the background', async () => {
    h = server(
      { a2a: null },
      {
        'PATCH /profile': {
          body: TEXT(
            'a2a_card_url: https://agents.example.com/.well-known/agent-card.json\na2a_status: pending',
          ),
        },
      },
    );
    expect(
      await h.run('profile', 'a2a', 'set', 'https://Agents.Example.com:443/.well-known/agent-card.json'),
    ).toBe(0);
    const w = writes()[0]!;
    expect([w.headers['content-type'], w.headers['if-match']]).toEqual([
      'application/merge-patch+json',
      ETAG,
    ]);
    expect(JSON.parse(w.body!)).toEqual({
      a2a: { cardUrl: 'https://Agents.Example.com:443/.well-known/agent-card.json' },
    });
    expect(h.stdout()).toContain(`a2a_card_url: ${URL_}`);
    expect(h.stderr()).toMatch(/in the background/);
  });

  it('set --wait: polls until the check ran, then shows the result', async () => {
    let gets = 0;
    h = server(
      { a2a: null },
      {
        'PATCH /profile': { body: TEXT('a2a_status: pending') },
        'GET /profile': (req) => {
          if (req.url.searchParams.get('format') !== 'json')
            return { headers: { etag: ETAG }, body: TEXT('a2a_status: reachable') };
          gets++;
          const a2a = gets === 1 ? null : { cardUrl: URL_, facts: gets < 4 ? PENDING : DONE };
          return { headers: { etag: ETAG }, body: JSON.stringify({ ...BASE, a2a }) };
        },
      },
    );
    expect(await h.run('profile', 'a2a', 'set', URL_, '--wait')).toBe(0);
    expect(h.stdout()).toContain('a2a_status: reachable');
  });

  it('set on an unclaimed handle: 403 claim_required_for_a2a, the hint is shown, exit 3', async () => {
    h = server(
      { a2a: null },
      {
        'PATCH /profile': {
          status: 403,
          body: '# error: claim_required_for_a2a\nmessage: Only a claimed handle can declare an A2A Agent Card.\nhint: POST /api/v1/claim {"method":"api_token"}\n',
        },
      },
    );
    expect(await h.run('profile', 'a2a', 'set', URL_)).toBe(3);
    expect(h.stderr()).toMatch(/claim_required_for_a2a/);
    expect(h.stderr()).toMatch(/hint:/);
  });

  it("set refused (422 profile_invalid): swarmsay's field message on stderr, exit 1", async () => {
    h = server(
      { a2a: null },
      {
        'PATCH /profile': {
          status: 422,
          body: '# error: profile_invalid\na2a.cardUrl: The address must use https.\n',
        },
      },
    );
    expect(await h.run('profile', 'a2a', 'set', 'http://x.example')).toBe(1);
    expect(h.stderr()).toContain('a2a.cardUrl: The address must use https.');
  });

  it('503 profile_busy: retried once after Retry-After; a second busy gives up with exit 5', async () => {
    let n = 0;
    const busy: Reply = { status: 503, headers: { 'retry-after': '1' }, body: '# error: profile_busy\n' };
    h = server(
      { a2a: null },
      { 'PATCH /profile': () => (++n === 1 ? busy : { body: TEXT('a2a_status: pending') }) },
    );
    expect(await h.run('profile', 'a2a', 'set', URL_)).toBe(0);
    expect(n).toBe(2);
    h.cleanup();
    n = 0;
    h = server({ a2a: null }, { 'PATCH /profile': () => (++n, busy) });
    expect(await h.run('profile', 'a2a', 'set', URL_)).toBe(5);
    expect(n).toBe(2);
    expect(h.stderr()).not.toMatch(/maintenance/);
  });

  it('remove: {"a2a": null}, also while switched off', async () => {
    h = server({ off: true }, { 'PATCH /profile': { body: '# swarmsay · profile @scout-7\n' } });
    expect(await h.run('profile', 'a2a', 'remove')).toBe(0);
    expect(JSON.parse(writes()[0]!.body!)).toEqual({ a2a: null });
    expect(h.stderr()).toMatch(/removed/);
  });

  it('refresh: 202, then waits until the check ran and shows the result', async () => {
    let gets = 0;
    h = server(
      { a2a: null },
      {
        'POST /profile/a2a/check': { status: 202, body: 'A check of the address is queued.\n' },
        'GET /profile': (req) => {
          if (req.url.searchParams.get('format') !== 'json')
            return { headers: { etag: ETAG }, body: TEXT('a2a_status: reachable') };
          gets++;
          return {
            headers: { etag: ETAG },
            body: JSON.stringify({ ...BASE, a2a: { cardUrl: URL_, facts: gets < 3 ? PENDING : DONE } }),
          };
        },
      },
    );
    expect(await h.run('profile', 'a2a', 'refresh')).toBe(0);
    expect(writes()[0]!.method).toBe('POST');
    expect(writes()[0]!.body ?? '').toBe('');
    expect(h.stdout()).toContain('A check of the address is queued.');
    expect(h.stdout()).toContain('a2a_status: reachable');
  });

  it('refresh: still queued after 3 minutes is not a failure', async () => {
    h = server(
      { a2a: { cardUrl: URL_, facts: PENDING } },
      { 'POST /profile/a2a/check': { status: 202, body: 'queued\n' } },
    );
    expect(await h.run('profile', 'a2a', 'refresh')).toBe(0);
    expect(h.stderr()).toMatch(/Still queued/);
    expect(h.calls.filter((c) => c.method === 'GET').length).toBeLessThanOrEqual(20);
  });

  it('refresh --no-wait returns after the 202; a 200 (blocked host, or not checked now) is not an error', async () => {
    h = server(
      { a2a: { cardUrl: URL_, facts: PENDING } },
      { 'POST /profile/a2a/check': { status: 202, body: 'queued\n' } },
    );
    expect(await h.run('profile', 'a2a', 'refresh', '--no-wait')).toBe(0);
    expect(h.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    h.cleanup();
    h = server(
      { a2a: { cardUrl: URL_, facts: DONE } },
      {
        'POST /profile/a2a/check': {
          status: 200,
          body: 'Checks on this host are blocked by the operator.\n',
        },
      },
    );
    expect(await h.run('profile', 'a2a', 'refresh')).toBe(0);
    expect(h.stdout()).toContain('blocked by the operator');
  });

  it('refresh with no address declared: says how to set one, sends nothing', async () => {
    h = server({ a2a: null });
    expect(await h.run('profile', 'a2a', 'refresh')).toBe(1);
    expect(h.stderr()).toMatch(/a2a set URL/);
    expect(writes()).toHaveLength(0);
  });

  it('refresh rate limited: 429 with the wait, exit 4', async () => {
    h = server(
      { a2a: { cardUrl: URL_, facts: DONE } },
      {
        'POST /profile/a2a/check': {
          status: 429,
          headers: { 'retry-after': '1200' },
          body: '# error: rate_limited\n',
        },
      },
    );
    expect(await h.run('profile', 'a2a', 'refresh')).toBe(4);
    expect(h.stderr()).toMatch(/1200/);
  });
});

describe('profile edit and the A2A address', () => {
  function editing(transform: (doc: Record<string, unknown>) => Record<string, unknown>) {
    h.io.edit = async (path) => {
      writeFileSync(path, JSON.stringify(transform(JSON.parse(readFileSync(path, 'utf8')))));
    };
  }

  it('deleting the a2a block asks first; "n" keeps the address and saves nothing', async () => {
    h = server(
      { a2a: { cardUrl: URL_, facts: DONE } },
      { 'PUT /profile': { body: 'saved\n' } },
      { tty: true, answers: ['n', 'n'] },
    );
    editing(({ a2a: _a2a, ...rest }) => ({ ...rest, summary: 'changed' }));
    expect(await h.run('profile', 'edit')).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(h.stderr()).toMatch(/removes the A2A Agent Card address/);
    expect(h.stderr()).toMatch(/The address is kept/);
  });

  it('"y" removes it: the PUT has no a2a', async () => {
    h = server(
      { a2a: { cardUrl: URL_, facts: DONE } },
      { 'PUT /profile': { body: 'saved\n' } },
      { tty: true, answers: ['y'] },
    );
    editing(({ a2a: _a2a, ...rest }) => ({ ...rest, summary: 'changed' }));
    expect(await h.run('profile', 'edit')).toBe(0);
    expect(JSON.parse(writes()[0]!.body!)).not.toHaveProperty('a2a');
  });
});
