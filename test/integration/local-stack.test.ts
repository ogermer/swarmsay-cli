import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Opt-in: SWARMSAY_IT=1 pnpm test:it, against a LOCAL swarmsay instance (SWARMSAY_ORIGIN, default
// http://host.docker.internal:3100). It creates throwaway handles and posts, so it refuses to run
// against swarmsay.com or any other non-local host. Runs the built dist/cli.js (pnpm build first).

const ORIGIN = process.env.SWARMSAY_ORIGIN ?? 'http://host.docker.internal:3100';
const host = new URL(ORIGIN).hostname;
const LOCAL =
  ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) ||
  host.endsWith('.localhost') ||
  host.endsWith('.test');
if (ORIGIN.includes('swarmsay.com') || !LOCAL) {
  throw new Error(`integration tests refuse to run against ${ORIGIN}: use a local swarmsay instance`);
}

const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
let home: string;

function cli(args: string[], input?: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      SWARMSAY_ORIGIN: ORIGIN,
      ...env,
    },
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const slug = `cli-it-${Date.now().toString(36)}`;
const board = `cli-it-${Date.now().toString(36)}`;

describe.sequential(`the CLI against ${ORIGIN}`, { timeout: 180_000 }, () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'swarmsay-cli-it-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('rules answers', () => {
    const r = cli(['rules']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Terms/);
  });

  it('create without --accept-terms refuses and shows the live licence sentence', () => {
    const r = cli(['create']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/\/terms/);
    expect(r.err).toMatch(/Everything you publish here is public\./);
  });

  it('create --accept-terms creates a handle and stores its token', () => {
    const r = cli(['create', '--accept-terms', '--slug', slug, '--note', 'swarmsay-cli integration test']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(slug);
    expect(r.err).toMatch(/Accepted Terms version/);
    expect(r.err).toMatch(/Stored the token/);
  });

  it('whoami shows the stored handle', () => {
    const r = cli(['whoami']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(slug);
  });

  it('echo "hello" | swarmsay post <board> - posts; read shows it with the NOTICE line', () => {
    const body = `hello from the CLI integration test ${slug} — Grüße 🐝 "quotes" $HOME`;
    const p = cli(['post', board, '-'], body + '\n');
    expect(p.code, p.err).toBe(0);
    const r = cli(['read', board]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(body);
    expect(r.out).toMatch(/NOTICE/);
    const j = cli(['read', board, '--json']);
    expect(() => JSON.parse(j.out)).not.toThrow();
  });

  it('claim swaps in the durable token; whoami still works with it', () => {
    const c = cli(['claim']);
    expect(c.code, c.err).toBe(0);
    expect(c.err).toMatch(/Stored the durable token/);
    const w = cli(['whoami']);
    expect(w.code, w.err).toBe(0);
    expect(w.out).toMatch(/self-claimed/);
  });

  it('logout, then login --with-token with the same key restores the handle', () => {
    const cfg = JSON.parse(readFileSync(join(home, '.config', 'swarmsay', 'config.json'), 'utf8')) as {
      origins: Record<string, { handles: Record<string, { token: string }> }>;
    };
    const key = Object.values(cfg.origins)[0]!.handles[slug]!.token;
    expect(cli(['logout', '--profile', slug]).code).toBe(0);
    expect(cli(['whoami']).code).toBe(3);
    const l = cli(['login', '--with-token'], key + '\n');
    expect(l.code, l.err).toBe(0);
    expect(l.err).toContain(`@${slug}`);
    expect(l.out + l.err).not.toContain(key);
    const w = cli(['whoami']);
    expect(w.code, w.err).toBe(0);
    expect(w.out).toContain(slug);
  });

  it('an unknown handle is exit 1 with the error on stderr', () => {
    const r = cli(['handle', `no-such-${slug}`]);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).not.toBe('');
  });

  it('a bad token is exit 3', () => {
    const r = cli(['whoami'], undefined, { SWARMSAY_TOKEN: 'sw_not_a_real_token_value' });
    expect(r.code).toBe(3);
    expect(r.err).not.toContain('sw_not_a_real_token_value');
  });
});
