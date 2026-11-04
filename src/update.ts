// `swarmsay update`: looks up the latest published version on the npm registry and, only when asked,
// installs it with the package manager this copy was installed with. Nothing here runs by itself: no
// other command calls it, and an install needs a yes at the prompt or --yes.

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RunArgs } from './commands.js';
import { USER_AGENT } from './http.js';
import { CliError, EXIT, type Io } from './io.js';
import { VERSION } from './version.js';

export const REGISTRY_URL = 'https://registry.npmjs.org/swarmsay/latest';
const TIMEOUT_MS = 5000;
/** `update` only: a newer version exists and was not installed. */
export const EXIT_UPDATE_AVAILABLE = 3;

type Method = 'npm' | 'pnpm' | 'npx' | 'brew' | 'unknown';

interface Install {
  method: Method;
  /** The package manager's global bin folder (npm and pnpm only), to ask the new copy its version. */
  binDir?: string;
}

interface Latest {
  version: string;
  integrity: string | undefined;
  provenance: boolean;
}

/** Compares two `x.y.z` versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const slash = (p: string): string => p.replace(/\\/g, '/');
const under = (path: string, dir: string): boolean =>
  slash(path).startsWith(slash(dir).replace(/\/$/, '') + '/');

async function capture(io: Io, cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await io.spawn(cmd, args, 'capture');
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How this copy was installed, from the path it was started from and that path with symlinks resolved
 * (npm links its bin to the package; pnpm 10 and later may keep the real files in a shared store).
 */
export async function detectInstall(io: Io): Promise<Install> {
  const scripts = io.scriptPaths.map(slash);
  const any = (test: (p: string) => boolean) => scripts.some(test);
  if (any((p) => p.includes('/_npx/'))) return { method: 'npx' };
  if (any((p) => p.includes('/Cellar/swarmsay/'))) return { method: 'brew' };
  // On Windows npm and pnpm are .cmd scripts, which cannot be started without a shell; the CLI then
  // prints the command instead of running it.
  if (io.platform === 'win32') return { method: 'unknown' };
  const prefix = await capture(io, 'npm', ['prefix', '-g']);
  if (prefix) {
    const dirs = [
      join(prefix, 'lib', 'node_modules', 'swarmsay'),
      join(real(prefix), 'lib', 'node_modules', 'swarmsay'),
    ];
    if (any((p) => dirs.some((d) => under(p, d)))) return { method: 'npm', binDir: join(prefix, 'bin') };
  }
  const root = await capture(io, 'pnpm', ['root', '-g']);
  if (root && any((p) => under(p, root) || under(p, real(root)))) {
    return { method: 'pnpm', binDir: await capture(io, 'pnpm', ['bin', '-g']) };
  }
  return { method: 'unknown' };
}

/** What runs on yes (npm and pnpm), or the command the user runs themselves. */
function plan(install: Install, version: string): { argv?: [string, string[]]; command: string } {
  const pkg = `swarmsay@${version}`;
  switch (install.method) {
    case 'npm':
      return { argv: ['npm', ['install', '-g', pkg]], command: `npm install -g ${pkg}` };
    case 'pnpm':
      return { argv: ['pnpm', ['add', '-g', pkg]], command: `pnpm add -g ${pkg}` };
    case 'npx':
      return { command: `npx ${pkg}` };
    case 'brew':
      return { command: 'brew upgrade swarmsay' };
    default:
      return { command: `npm install -g ${pkg}` };
  }
}

async function fetchLatest(io: Io): Promise<Latest> {
  let res: Response;
  try {
    res = await io.fetch(REGISTRY_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const why = (e as Error)?.name === 'TimeoutError' ? 'no answer within 5 seconds' : 'are you offline?';
    throw new CliError(`could not reach registry.npmjs.org (${why})`, EXIT.refused);
  }
  if (!res.ok) throw new CliError(`registry.npmjs.org answered ${res.status}`, EXIT.refused);
  let doc: { version?: unknown; dist?: { integrity?: unknown; attestations?: unknown } };
  try {
    doc = (await res.json()) as typeof doc;
  } catch {
    throw new CliError('registry.npmjs.org sent something that is not JSON', EXIT.refused);
  }
  if (typeof doc?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.version)) {
    throw new CliError('registry.npmjs.org did not name a version of swarmsay', EXIT.refused);
  }
  return {
    version: doc.version,
    integrity: typeof doc.dist?.integrity === 'string' ? doc.dist.integrity : undefined,
    provenance: doc.dist?.attestations != null,
  };
}

export async function runUpdate(a: RunArgs): Promise<number> {
  const { ctx } = a;
  const { io, output } = ctx;
  const checkOnly = a.values.check === true;
  const yes = a.values.yes === true;
  if (checkOnly && yes)
    throw new CliError('--check installs nothing, so --yes has no meaning with it', EXIT.usage);
  const asJson = ctx.format === 'json';

  const latest = await fetchLatest(io);
  const cmp = compareVersions(latest.version, VERSION);
  const updateAvailable = cmp > 0;
  const install = await detectInstall(io);
  const { argv, command } = plan(install, latest.version);
  const release = `https://github.com/ogermer/swarmsay-cli/releases/tag/v${latest.version}`;

  const doc = {
    installed: VERSION,
    latest: latest.version,
    updateAvailable,
    method: install.method,
    command: updateAvailable ? command : null,
    provenance: latest.provenance,
    integrity: latest.integrity ?? null,
    release,
    updated: false,
  };
  const finish = (code: number, lines: string[]): number => {
    if (asJson) output.out(JSON.stringify(doc, null, 2) + '\n');
    else if (lines.length) output.out(lines.join('\n') + '\n');
    return code;
  };

  if (!updateAvailable) {
    return finish(EXIT.ok, [
      cmp === 0
        ? `swarmsay ${VERSION} is up to date.`
        : `swarmsay ${VERSION} is newer than npm's latest (${latest.version}); nothing to do.`,
    ]);
  }

  const facts = [
    `swarmsay ${VERSION} is installed; ${latest.version} is out.`,
    `release: ${release}`,
    `npm provenance: ${latest.provenance ? 'present' : 'missing'}${latest.integrity ? `; integrity ${latest.integrity}` : ''}`,
  ];
  if (checkOnly)
    return finish(EXIT_UPDATE_AVAILABLE, [...facts, `update: swarmsay update (runs: ${command})`]);

  if (!latest.provenance) {
    output.err(
      `swarmsay: ${latest.version} has no npm provenance on the registry, so swarmsay update will not install it. If you trust it anyway: ${command}\n`,
    );
    return finish(EXIT.refused, facts);
  }
  if (!argv) {
    const how =
      install.method === 'npx'
        ? `npx fetches the latest on its next run; to be sure: ${command}`
        : install.method === 'brew'
          ? `installed with Homebrew: ${command}`
          : `could not tell how swarmsay was installed, so it installs nothing; to update: ${command}`;
    return finish(EXIT_UPDATE_AVAILABLE, [...facts, how]);
  }
  if (!yes && !(io.stdinIsTTY && io.stderrIsTTY)) {
    return finish(EXIT_UPDATE_AVAILABLE, [
      ...facts,
      `no terminal to ask on, so nothing was installed: run swarmsay update --yes, or ${command}`,
    ]);
  }
  if (!yes) {
    if (!asJson) output.out(facts.join('\n') + '\n');
    const answer = await io.prompt(`Update swarmsay ${VERSION} → ${latest.version}? Runs: ${command} [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      return finish(EXIT_UPDATE_AVAILABLE, asJson ? [] : ['Nothing was installed.']);
    }
  } else if (!asJson) {
    output.out([...facts, `running: ${command}`].join('\n') + '\n');
  }

  // npm's own output goes to the terminal; with --json it goes to stderr, so stdout stays one document.
  let result: { code: number | null };
  try {
    result = await io.spawn(argv[0], argv[1], asJson ? 'stderr' : 'inherit');
  } catch (e) {
    throw new CliError(
      `could not start ${argv[0]} (${(e as Error).message}); to update: ${command}`,
      EXIT.refused,
    );
  }
  if (result.code !== 0) {
    output.err(
      `swarmsay: ${argv[0]} ended with exit code ${result.code}; nothing may have changed. If it was a permission error, run it yourself with the rights it needs (swarmsay never uses sudo): ${command}\n`,
    );
    return finish(EXIT.refused, []);
  }
  // Ask the copy the package manager just installed; if its bin folder is unknown, the one on PATH.
  const now = await capture(io, install.binDir ? join(install.binDir, 'swarmsay') : 'swarmsay', [
    '--version',
  ]);
  doc.updated = now === latest.version;
  if (!doc.updated) {
    output.err(
      `swarmsay: ${argv[0]} finished, but the installed copy reports ${now ?? 'no version'}, not ${latest.version}. Check with: swarmsay --version\n`,
    );
    return finish(EXIT.refused, []);
  }
  return finish(EXIT.ok, asJson ? [] : [`swarmsay is now ${now}.`]);
}
