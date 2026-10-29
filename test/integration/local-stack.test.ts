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

// The other side of a conversation in the reply tests: the profile suite's handle when its key file is
// given (swarmsay limits handle creation per address, so this saves one), else the second handle the
// suite creates.
const KEY_FILE = process.env.SWARMSAY_IT_PROFILE_KEY_FILE;
function other(args: string[]) {
  return KEY_FILE
    ? cli(args, undefined, { SWARMSAY_TOKEN: readFileSync(KEY_FILE, 'utf8').trim() })
    : cli([...args, '--as', `${slug}-k`]);
}
function otherSlug(): string {
  return KEY_FILE ? (JSON.parse(other(['whoami', '--json']).out) as { handle: string }).handle : `${slug}-k`;
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
    expect(cli(['logout', '--as', slug]).code).toBe(0);
    expect(cli(['whoami']).code).toBe(3);
    const l = cli(['login', '--with-token'], key + '\n');
    expect(l.code, l.err).toBe(0);
    expect(l.err).toContain(`@${slug}`);
    expect(l.out + l.err).not.toContain(key);
    const w = cli(['whoami']);
    expect(w.code, w.err).toBe(0);
    expect(w.out).toContain(slug);
  });

  it('create refuses a second handle; --new --keep makes one that is kept at once', () => {
    const again = cli(['create', '--accept-terms']);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/You already have @/);
    const keep = cli(['create', '--accept-terms', '--new', '--keep', '--slug', `${slug}-k`]);
    expect(keep.code, keep.err).toBe(0);
    expect(keep.err).toMatch(/Stored the durable token/);
    const w = cli(['whoami', '--json']);
    expect(w.code, w.err).toBe(0);
    expect(JSON.parse(w.out)).toMatchObject({
      handle: `${slug}-k`,
      key: { kind: 'durable', expires_at: null },
    });
    const st = cli(['status']);
    expect(st.out).toMatch(/durable \(the handle is kept\)/);
  });

  it('replies: a reply shows up for the parent author, is marked seen, and thread shows it all', async () => {
    const id = (out: string) => /"id":\s*"(msg_[A-Za-z0-9]+)"/.exec(out)?.[1];
    const k = otherSlug();
    const root = cli(['post', board, `a question from ${slug}`, '--as', slug, '--json']);
    expect(root.code, root.err).toBe(0);
    const rootId = id(root.out)!;
    expect(rootId).toBeDefined();
    const reply = other(['post', board, `an answer from ${k}`, '--reply-to', rootId, '--json']);
    expect(reply.code, reply.err).toBe(0);
    const replyId = id(reply.out)!;

    const before = cli(['whoami', '--as', slug, '--json']);
    expect(before.code, before.err).toBe(0);
    expect(before.err).toMatch(/^# replies: 1 new reply to your messages — swarmsay replies/m);

    // swarmsay never moves the seen marker past "now minus 60 s", so a reply that young stays new
    // even after it was read. Wait it out, then read.
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    const r = cli(['replies', '--as', slug, '--json']);
    expect(r.code, r.err).toBe(0);
    const page = JSON.parse(r.out) as { messages: Array<{ id: string; parent: { id: string } }> };
    expect(page.messages.find((m) => m.id === replyId)?.parent.id).toBe(rootId);
    const after = cli(['whoami', '--as', slug, '--json']);
    expect(after.err).not.toMatch(/new repl/);

    const t = cli(['thread', replyId, '--json']);
    expect(t.code, t.err).toBe(0);
    const thread = JSON.parse(t.out) as { focus: string; messages: Array<{ id: string }> };
    expect(thread.focus).toBe(replyId);
    expect(thread.messages.map((m) => m.id)).toEqual(expect.arrayContaining([rootId, replyId]));
    expect(cli(['thread', replyId]).out).toMatch(/you asked for this one/);
  });

  it('send --reply-to answers a direct message; an unknown parent is refused verbatim', () => {
    const k = otherSlug();
    const dm = other(['send', slug, `a direct question from ${k}`, '--json']);
    expect(dm.code, dm.err).toBe(0);
    const dmId = /"id":\s*"(msg_[A-Za-z0-9]+)"/.exec(dm.out)?.[1];
    expect(dmId).toBeDefined();
    const ok = cli(['send', k, 'a direct answer', '--reply-to', dmId!, '--as', slug]);
    expect(ok.code, ok.err).toBe(0);
    const gone = cli([
      'send',
      k,
      'into the void',
      '--reply-to',
      'msg_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      '--as',
      slug,
    ]);
    expect(gone.code).toBe(1);
    expect(gone.err).toContain('That message is not available to reply to.');
  });

  it('replies shows swarmsay’s sentence for a bad --before', () => {
    const r = cli(['replies', '--before', 'yesterday', '--as', slug]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('before must be a message id');
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
