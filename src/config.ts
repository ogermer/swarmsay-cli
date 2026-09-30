import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from './io.js';

// The config holds bearer tokens and nothing about Terms acceptance: that lives on the handle,
// server-side. Layout, per origin:
//   { "version": 1, "origins": { "<origin>": { "default": "<slug>", "handles": { "<slug>": {…} } } } }

export interface StoredHandle {
  token: string;
  /**
   * `ephemeral` from `create`, `durable` after `claim`, `imported` from `login --with-token`,
   * `issued` from `use` or `rotate` through an account login.
   */
  kind: 'ephemeral' | 'durable' | 'imported' | 'issued';
  saved_at: string;
  /** For an issued key: its id on swarmsay, so it can be revoked by id. */
  key_id?: string;
}

/**
 * An account credential (`swa_…`) from `swarmsay login`. It only manages handles and their keys; it is
 * never used for a handle route and never handed to an agent.
 */
export interface StoredAccount {
  token: string;
  device_name: string;
  expires_at?: string;
  saved_at: string;
}

interface OriginEntry {
  default?: string;
  handles: Record<string, StoredHandle>;
  account?: StoredAccount;
}

export interface ConfigFile {
  version: 1;
  origins: Record<string, OriginEntry>;
}

export function configPath(env: Record<string, string | undefined>, homedir: string): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/')
      ? env.XDG_CONFIG_HOME
      : join(homedir, '.config');
  return join(base, 'swarmsay', 'config.json');
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

export class ConfigStore {
  constructor(readonly path: string) {}

  /** Reads the config, refusing a file or directory that anyone but the owner can read. */
  load(): ConfigFile {
    const dir = dirname(this.path);
    let dirMode: number;
    try {
      dirMode = statSync(dir).mode;
    } catch {
      return empty();
    }
    if (dirMode & 0o077) {
      throw new CliError(
        `refusing to use ${dir}: it is accessible to other users (mode ${modeString(dirMode)}). Fix: chmod 700 ${dir}`,
        EXIT.usage,
      );
    }
    let fileMode: number;
    try {
      fileMode = statSync(this.path).mode;
    } catch {
      return empty();
    }
    if (fileMode & 0o077) {
      throw new CliError(
        `refusing to read ${this.path}: it is readable by other users (mode ${modeString(fileMode)}). Fix: chmod 600 ${this.path}`,
        EXIT.usage,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new CliError(`cannot parse ${this.path}; fix or remove it`, EXIT.usage);
    }
    if (!isConfig(parsed))
      throw new CliError(`unexpected contents in ${this.path}; fix or remove it`, EXIT.usage);
    return parsed;
  }

  /** Writes atomically: a 0600 temporary file in the 0700 directory, then a rename over the old one. */
  save(config: ConfigFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirMode = statSync(dir).mode;
    if (dirMode & 0o077) {
      throw new CliError(
        `refusing to write into ${dir}: it is accessible to other users (mode ${modeString(dirMode)}). Fix: chmod 700 ${dir}`,
        EXIT.usage,
      );
    }
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new CliError(`cannot write ${this.path}: ${(e as Error).message}`, EXIT.usage);
    }
  }

  get(origin: string, profile: string | undefined): { slug: string; handle: StoredHandle } | undefined {
    const entry = this.load().origins[origin];
    if (!entry) return undefined;
    const slug = profile ?? entry.default;
    if (!slug) return undefined;
    const handle = entry.handles[slug];
    return handle ? { slug, handle } : undefined;
  }

  /** Stores a token for a handle. `makeDefault` also makes it the origin's default profile. */
  put(
    origin: string,
    slug: string,
    token: string,
    kind: StoredHandle['kind'],
    makeDefault: boolean,
    keyId?: string,
  ): void {
    const config = this.load();
    const entry = (config.origins[origin] ??= { handles: {} });
    entry.handles[slug] = {
      token,
      kind,
      saved_at: new Date().toISOString(),
      ...(keyId ? { key_id: keyId } : {}),
    };
    if (makeDefault || !entry.default) entry.default = slug;
    this.save(config);
  }

  /** Makes a stored handle the origin's default; false if there is no such handle. */
  setDefault(origin: string, slug: string): boolean {
    const config = this.load();
    const entry = config.origins[origin];
    if (!entry?.handles[slug]) return false;
    entry.default = slug;
    this.save(config);
    return true;
  }

  /** All stored handles for an origin, and which one is the default. */
  list(origin: string): { default: string | undefined; handles: Record<string, StoredHandle> } {
    const entry = this.load().origins[origin];
    return { default: entry?.default, handles: entry?.handles ?? {} };
  }

  getAccount(origin: string): StoredAccount | undefined {
    return this.load().origins[origin]?.account;
  }

  putAccount(origin: string, account: Omit<StoredAccount, 'saved_at'>): void {
    const config = this.load();
    const entry = (config.origins[origin] ??= { handles: {} });
    entry.account = { ...account, saved_at: new Date().toISOString() };
    this.save(config);
  }

  /** Removes the account credential; returns it, or undefined if there was none. */
  removeAccount(origin: string): StoredAccount | undefined {
    const config = this.load();
    const entry = config.origins[origin];
    const account = entry?.account;
    if (!entry || !account) return undefined;
    delete entry.account;
    if (Object.keys(entry.handles).length === 0) delete config.origins[origin];
    this.save(config);
    return account;
  }

  /** Removes everything stored for an origin; returns the handle slugs removed and whether an account was. */
  removeOrigin(origin: string): { handles: string[]; account: boolean } {
    const config = this.load();
    const entry = config.origins[origin];
    if (!entry) return { handles: [], account: false };
    delete config.origins[origin];
    this.save(config);
    return { handles: Object.keys(entry.handles), account: entry.account !== undefined };
  }

  /** Removes a stored handle; returns its slug, or undefined if there was none. */
  remove(origin: string, profile: string | undefined): string | undefined {
    const config = this.load();
    const entry = config.origins[origin];
    if (!entry) return undefined;
    const slug = profile ?? entry.default;
    if (!slug || !entry.handles[slug]) return undefined;
    delete entry.handles[slug];
    if (entry.default === slug) {
      const next = Object.keys(entry.handles)[0];
      if (next) entry.default = next;
      else delete entry.default;
    }
    if (Object.keys(entry.handles).length === 0 && !entry.account) delete config.origins[origin];
    this.save(config);
    return slug;
  }
}

function empty(): ConfigFile {
  return { version: 1, origins: {} };
}

function isConfig(v: unknown): v is ConfigFile {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (c.version !== 1 || !c.origins || typeof c.origins !== 'object') return false;
  for (const entry of Object.values(c.origins as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') return false;
    const handles = (entry as Record<string, unknown>).handles;
    if (!handles || typeof handles !== 'object') return false;
    for (const h of Object.values(handles as Record<string, unknown>)) {
      if (!h || typeof h !== 'object' || typeof (h as Record<string, unknown>).token !== 'string')
        return false;
    }
  }
  return true;
}
