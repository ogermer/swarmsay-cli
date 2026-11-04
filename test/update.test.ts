import { afterEach, describe, expect, it } from 'vitest';
import { compareVersions, REGISTRY_URL } from '../src/update.js';
import { VERSION } from '../src/version.js';
import { harness, type Harness, type Reply, type SpawnHandler } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const bump = (v: string, i: 0 | 1 | 2, by = 1) =>
  v
    .split('.')
    .map((n, j) => (j === i ? Number(n) + by : j > i ? 0 : Number(n)))
    .join('.');
const NEWER = bump(VERSION, 1);
const OLDER = bump(VERSION, 0, -1).replace(/^-1/, '0');

const registry =
  (version: string, attestations = true): ((req: { url: URL }) => Reply) =>
  () => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'swarmsay',
      version,
      dist: {
        integrity: 'sha512-test',
        ...(attestations
          ? { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x' } }
          : {}),
      },
    }),
  });

const NPM_PREFIX = '/usr/local';
const NPM_SCRIPT = '/usr/local/lib/node_modules/swarmsay/dist/cli.js';
const NPM_BIN_LINK = '/usr/local/bin/swarmsay';
const PNPM_ROOT = '/home/me/.local/share/pnpm/global/5/node_modules';
const PNPM_BIN = '/home/me/.local/share/pnpm';
// pnpm 10: the real files under its global node_modules.
const PNPM_SCRIPT = `${PNPM_ROOT}/.pnpm/swarmsay@${VERSION}/node_modules/swarmsay/dist/cli.js`;
// pnpm 11: started from its global folder, the real files in a shared store elsewhere.
const PNPM11_ROOT = '/home/me/.local/share/pnpm/global/v11';
const PNPM11_STARTED = `${PNPM11_ROOT}/9bb03b/node_modules/swarmsay/dist/cli.js`;
const PNPM11_REAL = `/home/me/.local/share/pnpm-store/v11/links/@/swarmsay/${VERSION}/06c8/node_modules/swarmsay/dist/cli.js`;

/** The package managers' answers: where npm and pnpm install globally, and the new copy's version. */
function managers(over: { install?: number; newVersion?: string; pnpmRoot?: string } = {}): SpawnHandler {
  return (s) => {
    if (s.cmd === 'npm' && s.args[0] === 'prefix') return { code: 0, stdout: `${NPM_PREFIX}\n` };
    if (s.cmd === 'pnpm' && s.args[0] === 'root')
      return { code: 0, stdout: `${over.pnpmRoot ?? PNPM_ROOT}\n` };
    if (s.cmd === 'pnpm' && s.args[0] === 'bin') return { code: 0, stdout: `${PNPM_BIN}\n` };
    if (s.cmd.endsWith('swarmsay') && s.args[0] === '--version')
      return { code: 0, stdout: `${over.newVersion ?? NEWER}\n` };
    if ((s.cmd === 'npm' && s.args[0] === 'install') || (s.cmd === 'pnpm' && s.args[0] === 'add'))
      return { code: over.install ?? 0 };
    return new Error(`unexpected spawn ${s.cmd} ${s.args.join(' ')}`);
  };
}
const installs = (hh: Harness) => hh.spawns.filter((s) => s.args[0] === 'install' || s.args[0] === 'add');

describe('compareVersions', () => {
  it('compares x.y.z numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '0.10.0')).toBeLessThan(0);
  });
});

describe('update --check', () => {
  it('asks only the fixed registry URL, with no token, and says when it is up to date', async () => {
    h = harness({
      env: { SWARMSAY_TOKEN: 'sw_test_never_sent_anywhere_1234' },
      handler: registry(VERSION),
      scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
      spawn: managers(),
    });
    expect(await h.run('update', '--check')).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url.toString()).toBe(REGISTRY_URL);
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
    expect(h.calls[0]!.headers['user-agent']).toMatch(/^swarmsay-cli\//);
    expect(h.stdout()).toBe(`swarmsay ${VERSION} is up to date.\n`);
    expect(installs(h)).toHaveLength(0);
  });

  it('a newer version: says so with the release page, integrity and the command, exit 3, installs nothing', async () => {
    h = harness({ handler: registry(NEWER), scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
    expect(await h.run('update', '--check')).toBe(3);
    const out = h.stdout();
    expect(out).toContain(`swarmsay ${VERSION} is installed; ${NEWER} is out.`);
    expect(out).toContain(`https://github.com/ogermer/swarmsay-cli/releases/tag/v${NEWER}`);
    expect(out).toContain('npm provenance: present; integrity sha512-test');
    expect(out).toContain(`npm install -g swarmsay@${NEWER}`);
    expect(installs(h)).toHaveLength(0);
  });

  it('never downgrades: an installed version newer than npm latest is left alone', async () => {
    h = harness({ handler: registry(OLDER), scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
    expect(await h.run('update', '--yes')).toBe(0);
    expect(h.stdout()).toContain(`is newer than npm's latest (${OLDER}); nothing to do.`);
    expect(installs(h)).toHaveLength(0);
  });

  it('--json pins the document', async () => {
    h = harness({ handler: registry(NEWER), scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
    expect(await h.run('update', '--check', '--json')).toBe(3);
    expect(JSON.parse(h.stdout())).toEqual({
      installed: VERSION,
      latest: NEWER,
      updateAvailable: true,
      method: 'npm',
      command: `npm install -g swarmsay@${NEWER}`,
      provenance: true,
      integrity: 'sha512-test',
      release: `https://github.com/ogermer/swarmsay-cli/releases/tag/v${NEWER}`,
      updated: false,
    });
  });

  it('--check with --yes is a usage error', async () => {
    h = harness({ handler: registry(NEWER) });
    expect(await h.run('update', '--check', '--yes')).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe('update: registry failures are one line and exit 1', () => {
  const cases: Array<[string, () => Reply | Error, RegExp]> = [
    [
      'offline',
      () => new TypeError('fetch failed'),
      /could not reach registry\.npmjs\.org \(are you offline\?\)/,
    ],
    [
      'timeout',
      () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      /no answer within 5 seconds/,
    ],
    ['non-200', () => ({ status: 503, body: 'down' }), /registry\.npmjs\.org answered 503/],
    ['bad JSON', () => ({ body: '<html>' }), /not JSON/],
    ['no version', () => ({ body: '{"name":"swarmsay"}' }), /did not name a version/],
  ];
  for (const [name, reply, msg] of cases) {
    it(name, async () => {
      h = harness({ handler: reply, scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
      expect(await h.run('update')).toBe(1);
      expect(h.stderr()).toMatch(msg);
      expect(h.stderr().trim().split('\n')).toHaveLength(1);
      expect(h.stderr()).not.toMatch(/\bat .*:\d+:\d+/);
      expect(h.spawns).toHaveLength(0);
    });
  }
});

describe('update: install method', () => {
  it('npm global: runs npm install -g with the exact version, no shell, then checks the new version', async () => {
    h = harness({ handler: registry(NEWER), scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
    expect(await h.run('update', '--yes')).toBe(0);
    expect(installs(h)).toEqual([
      { cmd: 'npm', args: ['install', '-g', `swarmsay@${NEWER}`], output: 'inherit' },
    ]);
    const check = h.spawns.find((s) => s.args[0] === '--version')!;
    expect(check.cmd).toBe(`${NPM_PREFIX}/bin/swarmsay`);
    expect(h.stdout()).toContain(`swarmsay is now ${NEWER}.`);
  });

  it("pnpm global: runs pnpm add -g, then asks the copy in pnpm's bin folder", async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: [`${PNPM_BIN}/swarmsay`, PNPM_SCRIPT],
      spawn: managers(),
    });
    expect(await h.run('update', '--yes')).toBe(0);
    expect(installs(h)).toEqual([
      { cmd: 'pnpm', args: ['add', '-g', `swarmsay@${NEWER}`], output: 'inherit' },
    ]);
    expect(h.spawns.find((s) => s.args[0] === '--version')!.cmd).toBe(`${PNPM_BIN}/swarmsay`);
  });

  it('pnpm 11 with its shared store: recognised from the path it was started from', async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: [PNPM11_STARTED, PNPM11_REAL],
      spawn: managers({ pnpmRoot: PNPM11_ROOT }),
    });
    expect(await h.run('update', '--yes', '--json')).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({ method: 'pnpm', updated: true });
  });

  const printed: Array<[string, string, string]> = [
    ['npx', `/home/me/.npm/_npx/abc123/node_modules/swarmsay/dist/cli.js`, `npx swarmsay@${NEWER}`],
    ['brew', '/opt/homebrew/Cellar/swarmsay/0.9.0/libexec/dist/cli.js', 'brew upgrade swarmsay'],
    ['unknown', '/home/me/src/swarmsay-cli/dist/cli.js', `npm install -g swarmsay@${NEWER}`],
  ];
  for (const [method, scriptPath, command] of printed) {
    it(`${method}: prints \`${command}\` and runs nothing`, async () => {
      h = harness({ handler: registry(NEWER), scriptPaths: [scriptPath], spawn: managers() });
      expect(await h.run('update', '--yes', '--json')).toBe(3);
      expect(JSON.parse(h.stdout())).toMatchObject({ method, command, updated: false });
      expect(installs(h)).toHaveLength(0);
    });
  }

  it('Windows: runs nothing, prints the npm command', async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\swarmsay\\dist\\cli.js'],
      platform: 'win32',
      spawn: managers(),
    });
    expect(await h.run('update', '--yes')).toBe(3);
    expect(h.spawns).toHaveLength(0);
    expect(h.stdout()).toContain(`npm install -g swarmsay@${NEWER}`);
  });

  it('npm or pnpm missing: the method is unknown, nothing runs', async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
      spawn: () => Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }),
    });
    expect(await h.run('update', '--yes')).toBe(3);
    expect(h.stdout()).toContain('could not tell how swarmsay was installed');
  });
});

describe('update: asking first', () => {
  for (const answer of ['n', '', 'no']) {
    it(`answer ${JSON.stringify(answer)}: nothing installed, exit 3`, async () => {
      h = harness({
        handler: registry(NEWER),
        scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
        spawn: managers(),
        tty: true,
        answers: [answer],
      });
      expect(await h.run('update')).toBe(3);
      expect(h.stderr()).toContain(
        `Update swarmsay ${VERSION} → ${NEWER}? Runs: npm install -g swarmsay@${NEWER} [y/N]`,
      );
      expect(installs(h)).toHaveLength(0);
      expect(h.stdout()).toContain('Nothing was installed.');
    });
  }

  it('answer y: installs', async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
      spawn: managers(),
      tty: true,
      answers: ['y'],
    });
    expect(await h.run('update')).toBe(0);
    expect(installs(h)).toHaveLength(1);
  });

  it('no terminal and no --yes: prints the command, installs nothing, exit 3', async () => {
    h = harness({ handler: registry(NEWER), scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
    expect(await h.run('update')).toBe(3);
    expect(h.stdout()).toContain('no terminal to ask on, so nothing was installed');
    expect(installs(h)).toHaveLength(0);
  });

  it('missing provenance: refuses to install, even with --yes', async () => {
    h = harness({
      handler: registry(NEWER, false),
      scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
      spawn: managers(),
    });
    expect(await h.run('update', '--yes')).toBe(1);
    expect(h.stderr()).toContain('has no npm provenance');
    expect(h.stderr()).toContain(`npm install -g swarmsay@${NEWER}`);
    expect(installs(h)).toHaveLength(0);
  });
});

describe('update: after the install', () => {
  it('a failing install passes on the exit code, never retries with sudo, exit 1', async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
      spawn: managers({ install: 243 }),
    });
    expect(await h.run('update', '--yes')).toBe(1);
    expect(h.stderr()).toContain('npm ended with exit code 243');
    expect(h.stderr()).toContain('never uses sudo');
    expect(installs(h)).toHaveLength(1);
    expect(h.spawns.some((s) => s.cmd === 'sudo')).toBe(false);
  });

  it('the new copy reporting another version is exit 1 and updated: false', async () => {
    h = harness({
      handler: registry(NEWER),
      scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT],
      spawn: managers({ newVersion: VERSION }),
    });
    expect(await h.run('update', '--yes', '--json')).toBe(1);
    expect(JSON.parse(h.stdout()).updated).toBe(false);
  });

  it('--json: npm output goes to stderr, stdout is one document with updated: true', async () => {
    h = harness({ handler: registry(NEWER), scriptPaths: [NPM_BIN_LINK, NPM_SCRIPT], spawn: managers() });
    expect(await h.run('update', '--yes', '--json')).toBe(0);
    expect(installs(h)[0]!.output).toBe('stderr');
    expect(JSON.parse(h.stdout())).toMatchObject({ updated: true, latest: NEWER });
  });
});

describe('nothing else looks for updates', () => {
  it('version and an ordinary command never ask the registry', async () => {
    h = harness({
      env: { SWARMSAY_TOKEN: 'sw_test_ordinary_command_12345' },
      handler: (req) =>
        req.url.hostname === 'registry.npmjs.org'
          ? new Error('the registry must not be asked')
          : { body: 'ok\n' },
    });
    expect(await h.run('version')).toBe(0);
    expect(await h.run('--version')).toBe(0);
    await h.run('read', 'guestbook');
    await h.run('whoami');
    expect(h.calls.some((c) => c.url.hostname === 'registry.npmjs.org')).toBe(false);
    expect(h.spawns).toHaveLength(0);
  });
});
