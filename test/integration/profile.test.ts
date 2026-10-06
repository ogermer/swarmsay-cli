import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Opt-in end-to-end test of profiles, skills, Discover and account profiles against a LOCAL swarmsay
// instance. It needs a throwaway CLAIMED handle (its key in the file SWARMSAY_IT_PROFILE_KEY_FILE), and, for the
// account part, a person to approve a device login (the code is written to $SWARMSAY_IT_CODE_FILE).
//
//   SWARMSAY_IT=1 SWARMSAY_IT_PROFILE_KEY_FILE=/path/to/key [SWARMSAY_IT_ACCOUNT=1] \
//     pnpm vitest run test/integration/profile.test.ts

const ORIGIN = process.env.SWARMSAY_ORIGIN ?? 'http://host.docker.internal:3100';
const host = new URL(ORIGIN).hostname;
const LOCAL =
  ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) ||
  host.endsWith('.localhost') ||
  host.endsWith('.test');
if (ORIGIN.includes('swarmsay.com') || !LOCAL) {
  throw new Error(`integration tests refuse to run against ${ORIGIN}: use a local swarmsay instance`);
}
const KEY_FILE = process.env.SWARMSAY_IT_PROFILE_KEY_FILE;
// The key is read from a file, never passed on a command line.
const KEY = KEY_FILE ? readFileSync(KEY_FILE, 'utf8').trim() : undefined;
const ACCOUNT = process.env.SWARMSAY_IT_ACCOUNT === '1';
const CODE_FILE = process.env.SWARMSAY_IT_CODE_FILE ?? '/tmp/swarmsay-it-device-code.txt';
const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
const run = Date.now().toString(36);

let home: string;
let editor: string;
const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  SWARMSAY_ORIGIN: ORIGIN,
  ...extra,
});
function cli(args: string[], input?: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: env(extra),
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const asHandle = { SWARMSAY_TOKEN: KEY ?? '' };

describe.runIf(!!KEY)(`profiles against ${ORIGIN}`, { timeout: 15 * 60_000 }, () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'swarmsay-cli-it-profile-'));
    // A stand-in editor for `profile edit`: it rewrites the summary in the file it is given.
    editor = join(home, 'editor.mjs');
    writeFileSync(
      editor,
      `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.argv[2];\nconst d = JSON.parse(readFileSync(f, 'utf8'));\nd.summary = 'Edited in the editor, run ${run}.';\nwriteFileSync(f, JSON.stringify(d, null, 2));\n`,
    );
    chmodSync(editor, 0o755);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('set summary and topics, then the profile shows them and is ready to list', () => {
    expect(
      cli(
        ['profile', 'set', 'summary', `CLI end-to-end test ${run}: compares datasets.`],
        undefined,
        asHandle,
      ).code,
    ).toBe(0);
    expect(cli(['profile', 'set', 'topics', `cli-it-${run},open-data`], undefined, asHandle).code).toBe(0);
    const own = cli(['profile', '--json'], undefined, asHandle);
    expect(own.code, own.err).toBe(0);
    const doc = JSON.parse(own.out);
    expect(doc.summary).toBe(`CLI end-to-end test ${run}: compares datasets.`);
    expect(doc.topics).toEqual([`cli-it-${run}`, 'open-data']);
    expect(doc.listingReadiness.ready).toBe(true);
  });

  it('a field that does not validate: 422 with the field on stderr, exit 1', () => {
    const r = cli(['profile', 'set', 'topics', 'Not A Topic!'], undefined, asHandle);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/topics/);
  });

  it('skills add, list, rm', () => {
    const add = cli(
      [
        'skills',
        'add',
        `Dataset comparison ${run}`,
        '--desc',
        'Compare two public datasets.',
        '--tag',
        'open-data',
      ],
      undefined,
      asHandle,
    );
    expect(add.code, add.err).toBe(0);
    const list = cli(['skills', '--json'], undefined, asHandle);
    const skill = (JSON.parse(list.out) as Array<{ id: string; name: string }>).find(
      (s) => s.name === `Dataset comparison ${run}`,
    );
    expect(skill).toBeDefined();
    expect(cli(['skills', 'rm', skill!.id], undefined, asHandle).code).toBe(0);
    expect(cli(['skills', '--json'], undefined, asHandle).out).not.toContain(skill!.id);
  });

  it('list, then find shows it with why it matched; unlist hides it again', () => {
    expect(cli(['profile', 'list'], undefined, asHandle).code).toBe(0);
    const found = cli(['find', '--topic', `cli-it-${run}`]);
    expect(found.code, found.err).toBe(0);
    expect(found.out).toMatch(/NOTICE/);
    expect(found.out).toMatch(/matched/);
    expect(cli(['profile', 'unlist'], undefined, asHandle).code).toBe(0);
    expect(cli(['find', '--topic', `cli-it-${run}`, '--json']).out).not.toMatch(new RegExp(`cli-it-${run}"`));
  });

  it('edit is refused without a terminal and points to set --file', () => {
    const r = cli(['profile', 'edit'], undefined, { ...asHandle, EDITOR: editor });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/set --file/);
  });

  it('set --file round-trips the whole profile', () => {
    const own = JSON.parse(cli(['profile', '--json'], undefined, asHandle).out);
    for (const k of ['notice', 'schemaVersion', 'handle', 'listingReadiness', 'moderation', 'updatedAt'])
      delete own[k];
    own.lookingFor = `Collaborators for run ${run}.`;
    const file = join(home, 'p.json');
    writeFileSync(file, JSON.stringify(own));
    const r = cli(['profile', 'set', '--file', file], undefined, asHandle);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(cli(['profile', '--json'], undefined, asHandle).out).lookingFor).toBe(
      `Collaborators for run ${run}.`,
    );
  });

  it('profile show @handle reads the public page without a key', () => {
    const own = JSON.parse(cli(['profile', '--json'], undefined, asHandle).out);
    const r = cli(['profile', 'show', `@${own.handle}`]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(own.handle);
  });

  describe.runIf(ACCOUNT)('account profile (needs a device approval)', () => {
    it('login, set, publish, show SLUG, unpublish, logout', async () => {
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
      expect(await new Promise((r) => child.on('close', r)), err).toBe(0);

      const slug = `cli-it-${run}`;
      for (const [f, v] of [
        ['slug', slug],
        ['displayName', `CLI test ${run}`],
        ['summary', 'An account used by the CLI end-to-end test.'],
      ]) {
        const r = cli(['account', 'profile', 'set', f!, v!]);
        expect(r.code, r.err).toBe(0);
      }
      expect(cli(['account', 'profile', 'publish']).code).toBe(0);
      const pub = cli(['account', 'profile', 'show', slug]);
      expect(pub.code, pub.err).toBe(0);
      expect(pub.out).toContain(`CLI test ${run}`);
      expect(cli(['account', 'profile', 'unpublish']).code).toBe(0);
      expect(cli(['account', 'profile', 'show', slug]).code).toBe(1);
      expect(cli(['logout']).code).toBe(0);
    });
  });
});
