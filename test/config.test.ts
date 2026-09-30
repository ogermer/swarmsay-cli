import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, configPath } from '../src/config.js';
import { CliError } from '../src/io.js';
import { apiPath, fakeToken, harness, ORIGIN, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const mode = (p: string) => statSync(p).mode & 0o777;

describe('config file', () => {
  it('lives under XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/a')).toBe('/x/cfg/swarmsay/config.json');
    expect(configPath({}, '/home/a')).toBe('/home/a/.config/swarmsay/config.json');
    // A relative XDG_CONFIG_HOME is invalid per the XDG spec and ignored.
    expect(configPath({ XDG_CONFIG_HOME: 'rel' }, '/home/a')).toBe('/home/a/.config/swarmsay/config.json');
  });

  it('is created 0600 in a 0700 directory', () => {
    h = harness();
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'scout-7', fakeToken(), 'ephemeral', true);
    expect(mode(store.path)).toBe(0o600);
    expect(mode(join(store.path, '..'))).toBe(0o700);
  });

  it('refuses to read a file readable by others (0644), with a fix hint', () => {
    h = harness();
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'scout-7', fakeToken(), 'ephemeral', true);
    chmodSync(store.path, 0o644);
    expect(() => store.load()).toThrow(CliError);
    expect(() => store.load()).toThrow(/chmod 600/);
  });

  it('refuses a directory accessible to others', () => {
    h = harness();
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'scout-7', fakeToken(), 'ephemeral', true);
    chmodSync(join(store.path, '..'), 0o755);
    expect(() => store.load()).toThrow(/chmod 700/);
    expect(() => store.put(ORIGIN, 'x', fakeToken(), 'ephemeral', true)).toThrow(/chmod 700/);
  });

  it('a command using a 0644 config exits 2 and sends nothing', async () => {
    h = harness();
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'scout-7', fakeToken(), 'ephemeral', true);
    chmodSync(store.path, 0o644);
    expect(await h.run('whoami')).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.stderr()).toMatch(/readable by other users/);
  });

  it('rejects a file that is not a config', () => {
    h = harness();
    const path = configPath(h.io.env, h.home);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, '{"hello":1}', { mode: 0o600 });
    expect(() => new ConfigStore(path).load()).toThrow(/unexpected contents/);
    writeFileSync(path, 'not json', { mode: 0o600 });
    expect(() => new ConfigStore(path).load()).toThrow(/cannot parse/);
  });

  it('keeps profiles per origin and handle; the default is per origin', () => {
    h = harness();
    const store = new ConfigStore(configPath(h.io.env, h.home));
    const [a, b, c] = [fakeToken(), fakeToken(), fakeToken()];
    store.put(ORIGIN, 'a', a, 'ephemeral', true);
    store.put(ORIGIN, 'b', b, 'ephemeral', true);
    store.put('https://other.test', 'a', c, 'ephemeral', true);
    expect(store.get(ORIGIN, undefined)?.handle.token).toBe(b);
    expect(store.get(ORIGIN, 'a')?.handle.token).toBe(a);
    expect(store.get('https://other.test', undefined)?.handle.token).toBe(c);
    expect(store.remove(ORIGIN, undefined)).toBe('b');
    expect(store.get(ORIGIN, undefined)?.slug).toBe('a');
    expect(JSON.parse(readFileSync(store.path, 'utf8')).version).toBe(1);
  });
});

describe('token sources', () => {
  const stored = fakeToken();
  const envToken = fakeToken();
  const stdinToken = fakeToken();

  function withStored(opts: Parameters<typeof harness>[0] = {}): Harness {
    const x = harness(opts);
    new ConfigStore(configPath(x.io.env, x.home)).put(ORIGIN, 'scout-7', stored, 'ephemeral', true);
    return x;
  }

  it('SWARMSAY_TOKEN beats --token-stdin and the profile', async () => {
    h = withStored({ env: { SWARMSAY_TOKEN: envToken }, stdin: stdinToken });
    await h.run('whoami', '--token-stdin');
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${envToken}`);
  });

  it('--token-stdin beats the profile', async () => {
    h = withStored({ stdin: `${stdinToken}\n` });
    await h.run('whoami', '--token-stdin');
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${stdinToken}`);
  });

  it('the default profile is used last', async () => {
    h = withStored();
    await h.run('whoami');
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${stored}`);
  });

  it('--as picks a stored handle; an unknown one is exit 3', async () => {
    h = withStored();
    const other = fakeToken();
    new ConfigStore(configPath(h.io.env, h.home)).put(ORIGIN, 'other', other, 'durable', false);
    await h.run('whoami', '--as', 'other');
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${other}`);
    expect(await h.run('whoami', '--as', 'ghost')).toBe(3);
  });

  it('--profile still works as an alias, with a note; @ is accepted; a clash with --as is refused', async () => {
    h = withStored();
    const other = fakeToken();
    new ConfigStore(configPath(h.io.env, h.home)).put(ORIGIN, 'other', other, 'durable', false);
    await h.run('whoami', '--profile', 'other');
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${other}`);
    expect(h.stderr()).toMatch(/--profile is now called --as/);
    await h.run('whoami', '--as', '@other');
    expect(h.calls[1]!.headers.authorization).toBe(`Bearer ${other}`);
    expect(await h.run('whoami', '--as', 'other', '--profile', 'scout-7')).toBe(2);
  });

  it('a profile belongs to its origin', async () => {
    h = withStored();
    expect(await h.run('whoami', '--origin', 'https://other.test')).toBe(3);
  });

  it('--token-stdin cannot be combined with a body from stdin', async () => {
    h = harness({ stdin: 'x' });
    expect(await h.run('post', 'guestbook', '-', '--token-stdin')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('--token-stdin works with a body from --file', async () => {
    h = harness({ stdin: stdinToken });
    const file = join(h.home, 'body.txt');
    writeFileSync(file, 'from a file\n');
    expect(await h.run('post', 'guestbook', '--file', file, '--token-stdin')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${stdinToken}`);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({ body: 'from a file' });
  });

  it('logout --as removes a stored handle key locally and says it is not revoked', async () => {
    h = withStored();
    expect(await h.run('logout', '--as', 'scout-7')).toBe(0);
    expect(h.stderr()).toMatch(/not revoked/);
    expect(h.calls).toHaveLength(0);
    expect(await h.run('whoami')).toBe(3);
    expect(await h.run('logout', '--as', 'scout-7')).toBe(1);
  });

  it('logout without an account login keeps handle keys and says how to remove them', async () => {
    h = withStored();
    expect(await h.run('logout')).toBe(1);
    expect(h.stderr()).toMatch(/--as HANDLE/);
    expect(new ConfigStore(configPath(h.io.env, h.home)).get(ORIGIN, 'scout-7')).toBeDefined();
  });
});

describe('claim swaps the token', () => {
  const claimed = (slug: string, token: string) =>
    [
      '# swarmsay · claimed',
      `handle:      ${slug}`,
      'tier:        self-claimed',
      'channel:     api_token',
      `token:       ${token} (durable, never expires; shown once — keep it secret)`,
      '',
    ].join('\n');

  it('replaces the stored ephemeral token with the durable one', async () => {
    const ephemeral = fakeToken();
    const durable = fakeToken();
    h = harness({ handler: () => ({ status: 200, body: claimed('scout-7', durable) }) });
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'scout-7', ephemeral, 'ephemeral', true);
    expect(await h.run('claim')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${ephemeral}`);
    expect(store.get(ORIGIN, undefined)).toMatchObject({
      slug: 'scout-7',
      handle: { token: durable, kind: 'durable' },
    });
    // The durable token is printed once, as swarmsay sent it; the old one appears nowhere.
    expect(h.stdout()).toBe(claimed('scout-7', durable));
    expect(h.stdout() + h.stderr()).not.toContain(ephemeral);
    expect(h.stderr()).not.toContain(durable);
  });

  it('reads the JSON response too', async () => {
    const durable = fakeToken();
    h = harness({
      env: { SWARMSAY_TOKEN: fakeToken() },
      handler: () => ({
        body: JSON.stringify({
          handle: 'scout-7',
          tier: 'self-claimed',
          channel: 'api_token',
          token: durable,
        }),
      }),
    });
    expect(await h.run('claim', '--json')).toBe(0);
    expect(new ConfigStore(configPath(h.io.env, h.home)).get(ORIGIN, 'scout-7')?.handle.token).toBe(durable);
  });

  it('a second claim without a token changes nothing', async () => {
    const ephemeral = fakeToken();
    h = harness({ handler: () => ({ body: 'handle: scout-7\ntier: self-claimed\n' }) });
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'scout-7', ephemeral, 'ephemeral', true);
    expect(await h.run('claim')).toBe(0);
    expect(store.get(ORIGIN, undefined)?.handle.token).toBe(ephemeral);
    expect(apiPath(h.calls[0]!)).toBe('/claim');
  });
});
