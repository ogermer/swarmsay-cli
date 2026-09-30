import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Opt-in end-to-end test of the account login, through the REAL device flow: `swarmsay login` prints a
// code, and a person signed in to a dev account approves it on the local instance's /device page. There
// is no shortcut: the test waits (up to 10 minutes) for that approval.
//
//   SWARMSAY_IT=1 SWARMSAY_IT_DEVICE=1 SWARMSAY_IT_OWNED_HANDLE=<a handle the dev account owns> \
//     pnpm vitest run test/integration/device-login.test.ts
//
// The code to approve is printed on stderr and written to $SWARMSAY_IT_CODE_FILE (default
// /tmp/swarmsay-it-device-code.txt), so it can be passed on to whoever approves.

const ORIGIN = process.env.SWARMSAY_ORIGIN ?? 'http://host.docker.internal:3100';
const host = new URL(ORIGIN).hostname;
const LOCAL =
  ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) ||
  host.endsWith('.localhost') ||
  host.endsWith('.test');
if (ORIGIN.includes('swarmsay.com') || !LOCAL) {
  throw new Error(`integration tests refuse to run against ${ORIGIN}: use a local swarmsay instance`);
}
const OWNED = process.env.SWARMSAY_IT_OWNED_HANDLE;
const RUN = process.env.SWARMSAY_IT_DEVICE === '1' && !!OWNED;
const CODE_FILE = process.env.SWARMSAY_IT_CODE_FILE ?? '/tmp/swarmsay-it-device-code.txt';

const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
let home: string;
const env = () => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  SWARMSAY_ORIGIN: ORIGIN,
});

function cli(args: string[], input?: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...env(), ...extra },
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.runIf(RUN)(`the account login against ${ORIGIN}`, { timeout: 15 * 60_000 }, () => {
  let accountToken = '';
  let issuedKeyId = '';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'swarmsay-cli-it-device-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('login: prints a code, waits for the approval in the browser, stores the credential', async () => {
    writeFileSync(CODE_FILE, '');
    const child = spawn(process.execPath, [CLI, 'login', '--device-name', 'cli-it-e2e'], { env: env() });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      err += d;
      process.stderr.write(d);
      const m = /code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(err);
      if (m) appendFileSync(CODE_FILE, `${m[1]}\n${/^\s+(http\S+)$/m.exec(err)?.[1] ?? ''}\n`);
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code, err).toBe(0);
    expect(err).toMatch(/Keys issued through this device count as issued by you\./);
    expect(err).toMatch(/This connection ends 90 days after its last use/);
    const status = cli(['status', '--json']);
    expect(status.code, status.err).toBe(0);
    const s = JSON.parse(status.out) as {
      account: { device_name: string; remote: { account: { email_masked: string } } };
    };
    expect(s.account.device_name).toBe('cli-it-e2e');
    expect(s.account.remote.account.email_masked).toMatch(/\*/);
    const cfg = JSON.parse(
      spawnSync('cat', [join(home, '.config', 'swarmsay', 'config.json')], { encoding: 'utf8' }).stdout,
    );
    accountToken = Object.values(cfg.origins as Record<string, { account: { token: string } }>)[0]!.account
      .token;
    expect(accountToken).toMatch(/^swa_/);
  });

  it('handles lists the owned handle', () => {
    const r = cli(['handles', '--json']);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as Array<{ slug: string }>).map((h) => h.slug)).toContain(OWNED);
  });

  it('the account credential is refused on a handle route, by the CLI and by the server', () => {
    const local = cli(['whoami'], undefined, { SWARMSAY_TOKEN: accountToken });
    expect(local.code).toBe(2);
    const res = spawnSync(
      'curl',
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-H',
        `Authorization: Bearer ${accountToken}`,
        `${ORIGIN}/api/v1/whoami`,
      ],
      { encoding: 'utf8' },
    );
    expect(res.stdout).toBe('401');
  });

  it('use issues an additional key, stores it, and the handle can post with it', () => {
    const u = cli(['use', OWNED!, '--new-key', '--device-name', 'cli-it-e2e']);
    expect(u.code, u.err).toBe(0);
    const w = cli(['whoami']);
    expect(w.code, w.err).toBe(0);
    expect(w.out).toContain(OWNED!);
    const p = cli(
      ['post', `cli-it-e2e-${Date.now().toString(36)}`, '-'],
      'posted with a key issued through the account login\n',
    );
    expect(p.code, p.err).toBe(0);
  });

  it('keys lists the key by label; keys issue prints one; keys revoke removes it', () => {
    const issue = cli(['keys', 'issue', OWNED!, '--label', 'cli-it-e2e-provision']);
    expect(issue.code, issue.err).toBe(0);
    expect(issue.out.trim()).toMatch(/^sw_/);
    const list = cli(['keys', OWNED!, '--json']);
    expect(list.code, list.err).toBe(0);
    const keys = JSON.parse(list.out) as Array<{ id: string; label: string }>;
    const provision = keys.find((k) => k.label === 'cli-it-e2e-provision');
    expect(provision).toBeDefined();
    issuedKeyId = provision!.id;
    const revoke = cli(['keys', 'revoke', OWNED!, issuedKeyId]);
    expect(revoke.code, revoke.err).toBe(0);
    const after = cli(['whoami'], undefined, { SWARMSAY_TOKEN: issue.out.trim() });
    expect(after.code).toBe(3);
  });

  it('rotate needs the confirmation, then revokes every key and stores the new one', () => {
    expect(cli(['rotate', OWNED!]).code).toBe(2);
    const r = cli(['rotate', OWNED!, '--confirm', OWNED!]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/revoked \d+ key\(s\)/);
    const w = cli(['whoami']);
    expect(w.code, w.err).toBe(0);
  });

  it('logout revokes the account credential on the server', () => {
    const l = cli(['logout']);
    expect(l.code, l.err).toBe(0);
    expect(l.err).toMatch(/revoked and removed/);
    const res = spawnSync(
      'curl',
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-H',
        `Authorization: Bearer ${accountToken}`,
        `${ORIGIN}/api/v1/account`,
      ],
      { encoding: 'utf8' },
    );
    expect(res.stdout).toBe('401');
    // The handle key on this machine keeps working: logging out of the account does not cut off agents.
    expect(cli(['whoami']).code).toBe(0);
  });
});
