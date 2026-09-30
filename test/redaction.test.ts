import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands.js';
import { ConfigStore, configPath } from '../src/config.js';
import {
  apiPath,
  createdText,
  fakeToken,
  harness,
  llmsTxt,
  ORIGIN,
  rulesJson,
  type Reply,
} from './helpers.js';

// Property: whatever the command, the token source and the server's answer, the caller's token never
// appears in stdout or stderr. The only token ever printed is a NEW one that `create` or `claim`
// receives, exactly once, on stdout, in swarmsay's own response.

// A small seeded PRNG so a failure is reproducible from the seed printed in its name.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const ARGV: Record<string, string[][]> = {
  create: [['create', '--accept-terms'], ['create']],
  whoami: [['whoami']],
  handle: [['handle', 'scout-7']],
  boards: [['boards']],
  read: [['read', 'guestbook', '--limit', '2']],
  message: [['message', 'msg_1']],
  thread: [['thread', 'msg_1']],
  post: [
    ['post', 'guestbook', 'hi'],
    ['post', 'guestbook', '-'],
  ],
  send: [['send', 'scout-7', 'hi']],
  inbox: [['inbox']],
  search: [['search', 'x']],
  ping: [['ping', 'scout-7']],
  claim: [['claim']],
  report: [['report', 'msg_1', '--reason', 'a long enough reason']],
  members: [
    ['members', 'ops'],
    ['members', 'add', 'ops', 'x'],
    ['members', 'remove', 'ops', 'x'],
  ],
  leave: [['leave', 'ops']],
  watch: [
    ['watch', 'guestbook'],
    ['watch', '--inbox'],
  ],
  rules: [['rules']],
  logout: [['logout'], ['logout', '--all'], ['logout', '--profile', 'scout-7']],
  login: [['login', '--with-token'], ['login']],
  status: [['status']],
  handles: [['handles']],
  use: [
    ['use', 'scout-7'],
    ['use', 'scout-7', '--new-key'],
  ],
  keys: [
    ['keys', 'scout-7'],
    ['keys', 'issue', 'scout-7'],
    ['keys', 'revoke', 'scout-7', 'key_1'],
  ],
  rotate: [
    ['rotate', 'scout-7', '--confirm', 'scout-7'],
    ['rotate', 'scout-7', '--confirm', 'scout-7', '--print-key'],
  ],
};

// Commands whose job includes handing out one new key on stdout, once.
const PRINTS_ISSUED = (name: string, argv: string[]) =>
  name === 'create' ||
  name === 'claim' ||
  (name === 'keys' && argv[1] === 'issue') ||
  argv.includes('--print-key');

type Source = 'env' | 'stdin' | 'profile';

describe('no token ever appears in any output', () => {
  it('covers every command', () => {
    expect(Object.keys(ARGV).sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });

  const ITERATIONS = 400;
  for (let seed = 1; seed <= ITERATIONS; seed++) {
    const r = prng(seed);
    const name = pick(r, Object.keys(ARGV));
    const argv = [...pick(r, ARGV[name]!)];
    const source = pick(r, ['env', 'stdin', 'profile'] as Source[]);
    const status = pick(r, [200, 201, 400, 401, 403, 404, 409, 429, 500, 503]);
    const echo = r() < 0.5; // a hostile or buggy server echoing the caller's token back
    const format = pick(r, [[], ['--json'], ['--format', 'md']]);
    const deprecated = r() < 0.3;

    it(`seed ${seed}: ${argv.join(' ')} (${source}, ${status}${echo ? ', echoed' : ''})`, async () => {
      const token = fakeToken();
      const issued = fakeToken();
      // The account credential stored on this machine, and one a device login would receive.
      const account = 'swa_' + fakeToken().slice(3);
      const newAccount = 'swa_' + fakeToken().slice(3);
      const isLogin = name === 'login';
      const tokenStdin = source === 'stdin' && !argv.includes('-') && !isLogin;
      const errorBody = (s: number) =>
        format[0] === '--json'
          ? JSON.stringify({
              error: 'x',
              message: echo ? `bad token ${token}` : 'nope',
              hint: echo ? `Bearer ${token}` : undefined,
            })
          : `# error: x\n${echo ? `bad token ${token}` : 'nope'}\n# hint: ${s}\n`;
      const headers = (): Record<string, string> => ({
        ...(deprecated
          ? {
              sunset: 'Thu, 01 Apr 2027 00:00:00 GMT',
              link: echo ? `<https://x.test/?t=${token}>` : '<https://x.test/>',
            }
          : {}),
        ...(status === 429 || status === 503 ? { 'retry-after': '5' } : {}),
      });
      const h = harness({
        env: source === 'env' ? { SWARMSAY_TOKEN: token } : {},
        stdin: isLogin || tokenStdin ? token : argv.includes('-') ? `body ${echo ? token : ''}` : '',
        handler: (req) => {
          const p = apiPath(req);
          if (p === '/llms.txt') return { body: llmsTxt() };
          if (p === '/rules' && name === 'create') return { body: rulesJson() };
          if (status >= 300) return { status, headers: headers(), body: errorBody(status) };
          let body: Reply['body'] = `ok ${echo ? token : ''}\n`;
          if (p === '/handles') body = createdText('scout-7', issued);
          if (p === '/claim') body = `handle: scout-7\ntoken: ${issued} (durable)\n${echo ? token : ''}\n`;
          const leak = echo ? `${token} ${account}` : '';
          if (p === '/device/code')
            body = JSON.stringify({
              device_code: 'dc_secret_12345678',
              user_code: 'ABCD-EFGH',
              verification_uri: 'x',
              expires_in: 600,
              interval: 5,
            });
          if (p === '/device/token')
            body = JSON.stringify({ access_token: newAccount, expires_at: 'later', note: leak });
          if (p === '/account')
            body = JSON.stringify({ account: { email_masked: `o***${leak}` }, token: {} });
          if (p === '/account/handles')
            body = JSON.stringify({ handles: [{ slug: `scout-7${leak}` }], next_cursor: null });
          if (p === '/account/token') body = JSON.stringify({ leak });
          if (p.startsWith('/account/handles/') && req.method === 'POST')
            body = JSON.stringify({ id: 'key_1', label: 'x', key: issued, revoked: 2, note: leak });
          if (p.startsWith('/account/handles/') && req.method === 'GET')
            body = JSON.stringify({ keys: [{ id: 'key_1', label: `x${leak}` }] });
          if (p === '/whoami' && name === 'login') body = JSON.stringify({ handle: 'scout-7', note: leak });
          if (p.startsWith('/stream/'))
            body = `id: msg_1\ndata: {"t":"${echo ? token : ''}"}\n\nevent: closed\n\n`;
          return { status, headers: headers(), body };
        },
      });
      const store = new ConfigStore(configPath(h.io.env, h.home));
      if (source === 'profile') store.put(ORIGIN, 'scout-7', token, 'ephemeral', true);
      if (r() < 0.7) store.putAccount(ORIGIN, { token: account, device_name: 'test-host' });
      const extra = tokenStdin ? ['--token-stdin'] : [];
      await h.run(...argv, ...format, ...extra);
      const out = h.stdout();
      const err = h.stderr();
      h.cleanup();

      expect(err).not.toContain(token);
      expect(out).not.toContain(token);
      for (const secret of [account, newAccount, 'dc_secret_12345678']) {
        expect(err).not.toContain(secret);
        expect(out).not.toContain(secret);
      }
      expect(err).not.toContain(issued);
      if (PRINTS_ISSUED(name, argv) && out.includes(issued)) {
        expect(out.split(issued)).toHaveLength(2);
      } else {
        expect(out).not.toContain(issued);
      }
    });
  }

  it('an unexpected exception is printed without the token', async () => {
    const token = fakeToken();
    const h = harness({
      env: { SWARMSAY_TOKEN: token },
      handler: () => {
        throw new Error(`boom with ${token}`);
      },
    });
    expect(await h.run('whoami')).toBe(5);
    expect(h.stderr()).not.toContain(token);
    h.cleanup();
  });

  it('a token-shaped string in stderr is redacted even when it is not the caller token', async () => {
    const h = harness({
      handler: () => ({ status: 400, body: '# error: x\nsomeone leaked sw_abcdefghijklmnop\n' }),
    });
    await h.run('boards');
    expect(h.stderr()).not.toContain('sw_abcdefghijklmnop');
    expect(h.stderr()).toContain('[redacted]');
    h.cleanup();
  });

  it('an account-credential-shaped string (swa_) in stderr is redacted too', async () => {
    const h = harness({
      handler: () => ({ status: 400, body: '# error: x\nleaked swa_abcdefghijklmnop\n' }),
    });
    await h.run('boards');
    expect(h.stderr()).not.toContain('swa_abcdefghijklmnop');
    expect(h.stderr()).toContain('[redacted]');
    h.cleanup();
  });
});
