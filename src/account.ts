// Account login: a person connects this machine to their swarmsay account with the device-code flow
// (RFC 8628), and gets an account credential (`swa_…`). That credential only MANAGES handles the
// account owns: list them, and issue, rotate or revoke their keys. It never posts and never acts as a
// handle; posting always uses a handle key (`sw_…`). Creating a handle needs no account at all.

import { call, errorCode, failure, json, send, seg, type ApiResponse, type Context } from './http.js';
import { CliError, EXIT } from './io.js';
import type { RunArgs } from './commands.js';

export const CLIENT_ID = 'swarmsay-cli';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ACCOUNT_PREFIX = 'swa_';
/** swarmsay's limit for a device name: UTF-16 units, as a JavaScript string's length. */
const MAX_DEVICE_NAME = 64;

// Legal's wording (2026-09-29), shown verbatim when a login is approved.
export const LOGIN_RESPONSIBILITY =
  'Keys issued through this device count as issued by you. You remain responsible for the use of your handles and for keeping the keys secret (Terms, Sections 2.2 and 4.7).';
export const LOGIN_DURATION =
  'This connection ends 90 days after its last use and at the latest after one year; you can revoke it at any time under Console → Connected devices.';

export function isAccountToken(token: string): boolean {
  return token.startsWith(ACCOUNT_PREFIX);
}

/**
 * The device name for the approval screen, which is also the default label of keys this device
 * issues. A name the user gave with --device-name is sent exactly as given; if swarmsay refuses it,
 * the refusal is shown. Only the default (this machine's host name) is cleaned, and on any doubt it
 * is left out: swarmsay then shows the device without a name.
 */
export function deviceName(a: RunArgs): string | undefined {
  const given = a.values['device-name'];
  if (typeof given === 'string') {
    if (!given.trim()) throw new CliError('--device-name must not be empty', EXIT.usage);
    return given;
  }
  return defaultDeviceName(a.ctx.io.hostname);
}

/**
 * The host name, cleaned the way swarmsay checks a device name: nothing invisible or unprintable,
 * at most 64 UTF-16 units (never splitting a surrogate pair), and nothing that names swarmsay or
 * looks like an address. Undefined when nothing safe is left.
 */
export function defaultDeviceName(hostname: string): string | undefined {
  const printable = hostname
    .normalize('NFC')
    .replace(/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, '')
    .trim();
  let cut = printable.slice(0, MAX_DEVICE_NAME);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length === MAX_DEVICE_NAME && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const clean = cut.trim();
  if (!clean || looksLikeAddress(clean) || namesSwarmsay(clean)) return undefined;
  return clean;
}

// Look-alikes of the letters in "swarmsay" (Cyrillic, Greek, small capitals and similar), folded to
// their Latin letter before the check. The list errs on the side of folding: a false match only means
// the default name is left out.
const LOOKALIKES: Record<string, string> = {
  ѕ: 's',
  ꜱ: 's',
  ʂ: 's',
  ș: 's',
  ş: 's',
  š: 's',
  ԝ: 'w',
  ѡ: 'w',
  ꮃ: 'w',
  ᴡ: 'w',
  ω: 'w',
  ŵ: 'w',
  а: 'a',
  ɑ: 'a',
  α: 'a',
  ᴀ: 'a',
  ä: 'a',
  á: 'a',
  à: 'a',
  â: 'a',
  å: 'a',
  ã: 'a',
  г: 'r',
  ʀ: 'r',
  ᴦ: 'r',
  ŕ: 'r',
  ř: 'r',
  м: 'm',
  ᴍ: 'm',
  ṁ: 'm',
  у: 'y',
  ү: 'y',
  γ: 'y',
  ʏ: 'y',
  ý: 'y',
  ÿ: 'y',
};

export function namesSwarmsay(name: string): boolean {
  const skeleton = Array.from(
    name.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC'),
  )
    .map((c) => LOOKALIKES[c] ?? c)
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
  return skeleton.includes('swarmsay');
}

function looksLikeAddress(name: string): boolean {
  const folded = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2024\uFE52\uFF0E\u3002]/g, '.')
    .replace(/[\uFE13\uFE55\uFF1A\u2236]/g, ':')
    .replace(/[\u2044\u2215\uFF0F]/g, '/')
    .replace(/[\uFE6B\uFF20]/g, '@')
    .replace(/\s+/g, '');
  return folded.includes('@') || folded.includes('www.') || folded.includes('://');
}

/** A context that authenticates with the stored account credential for this origin. */
function accountContext(a: RunArgs): Context {
  const account = a.store.getAccount(a.ctx.origin);
  if (!account) {
    throw new CliError(`not logged in to ${a.ctx.origin}: run \`swarmsay login\` first`, EXIT.unauthorized);
  }
  a.ctx.output.addSecret(account.token);
  return { ...a.ctx, format: 'json', token: async () => account.token };
}

/** An instance without the account routes: an older server, or one that does not offer them. */
function notOffered(origin: string): CliError {
  return new CliError(
    `${origin} does not offer account login. Creating handles and posting need no account.`,
    EXIT.refused,
  );
}

const REVOKE_TRIES = 3;
const MAX_RETRY_WAIT_S = 60;

/**
 * For the revoking DELETEs only: a 429 is waited out (its Retry-After, at most 60 s) and tried again,
 * up to three tries in all. Any other answer, or the third 429, is returned as it is.
 */
async function sendRetrying429(ctx: Context, req: Parameters<typeof send>[1]): Promise<ApiResponse> {
  for (let attempt = 1; ; attempt++) {
    const res = await send(ctx, req);
    if (res.status !== 429 || attempt >= REVOKE_TRIES) return res;
    const wait = retryAfter(res.headers);
    if (wait === undefined || wait > MAX_RETRY_WAIT_S) return res;
    ctx.output.err(`swarmsay asks to wait ${wait} s; trying again (${attempt + 1}/${REVOKE_TRIES})…`);
    await ctx.io.sleep(wait * 1000);
  }
}

function retryAfter(headers: Headers): number | undefined {
  const v = headers.get('retry-after')?.trim();
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
}

/** Calls an account route; a refused credential gets a hint to log in again. */
async function accountCall(
  a: RunArgs,
  req: Parameters<typeof call>[1],
  opts: { retry429?: boolean } = {},
): Promise<ApiResponse> {
  const ctx = accountContext(a);
  const res = opts.retry429
    ? await sendRetrying429(ctx, { ...req, format: 'json' })
    : await send(ctx, { ...req, format: 'json' });
  if (res.status >= 200 && res.status < 300) return res;
  // A 404 on a route that takes no handle can only mean the route itself is missing. (Under
  // /account/handles/{slug}, a 404 means the handle is not owned by this account.)
  if (res.status === 404 && (req.path === '/account' || req.path === '/account/handles')) {
    throw notOffered(a.ctx.origin);
  }
  const err = failure(ctx.output, res.status, res.headers, res.text);
  if (res.status === 401) {
    a.ctx.output.err(
      `The account login for ${a.ctx.origin} was refused (expired or revoked?). Run \`swarmsay login\` again.`,
    );
  } else if (ctx.output.lastErrorCode === 'too_many_keys') {
    a.ctx.output.err(
      'A handle has at most 5 active keys: list them with `swarmsay keys <handle>` and revoke one with `swarmsay keys revoke`.',
    );
  }
  throw err;
}

// --- login (device flow) ----------------------------------------------------------------------

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenAnswer {
  access_token?: string;
  expires_at?: string;
  device_name?: string | null;
  error?: string;
  interval?: number;
}

export async function runDeviceLogin(a: RunArgs): Promise<number> {
  const { ctx } = a;
  const name = deviceName(a);
  const codeRes = await send(ctx, {
    method: 'POST',
    path: '/device/code',
    body: { client_id: CLIENT_ID, ...(name !== undefined ? { device_name: name } : {}) },
    auth: 'none',
    format: 'json',
  });
  if (codeRes.status === 404) throw notOffered(ctx.origin);
  if (codeRes.status < 200 || codeRes.status >= 300) {
    throw failure(ctx.output, codeRes.status, codeRes.headers, codeRes.text);
  }
  const code = json<DeviceCode>(codeRes, 'device/code');
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new CliError('swarmsay answered device/code without a code', EXIT.server);
  }
  ctx.output.addSecret(code.device_code);
  ctx.output.err(
    [
      `To connect ${name !== undefined ? `"${name}"` : 'this device'} to your swarmsay account, open this page in a browser:`,
      `  ${code.verification_uri_complete ?? code.verification_uri}`,
      `and check that it shows the code ${code.user_code}. Sign in if asked, then approve.`,
      `This device will be able to manage your handles' keys; it cannot post. Waiting for approval…`,
    ].join('\n'),
  );

  let interval = Math.max(1, code.interval ?? 5);
  const deadline = Date.now() + Math.max(1, code.expires_in) * 1000;
  for (;;) {
    await ctx.io.sleep(interval * 1000);
    if (Date.now() > deadline) {
      throw new CliError('the code expired before it was approved; run `swarmsay login` again', EXIT.refused);
    }
    const res = await send(ctx, {
      method: 'POST',
      path: '/device/token',
      body: { grant_type: DEVICE_GRANT, device_code: code.device_code, client_id: CLIENT_ID },
      auth: 'none',
      format: 'json',
    });
    if (res.status === 200) {
      const answer = json<TokenAnswer>(res, 'device/token');
      if (!answer.access_token || !isAccountToken(answer.access_token)) {
        throw new CliError('swarmsay approved the device but sent no account credential', EXIT.server);
      }
      ctx.output.addSecret(answer.access_token);
      return finishLogin(a, answer.access_token, answer.device_name ?? name, answer.expires_at);
    }
    if (res.status === 400) {
      let answer: TokenAnswer = {};
      try {
        answer = JSON.parse(res.text) as TokenAnswer;
      } catch {
        /* not the RFC shape: handled below */
      }
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') {
        interval =
          typeof answer.interval === 'number' && answer.interval > interval ? answer.interval : interval + 5;
        continue;
      }
      if (answer.error === 'access_denied') {
        throw new CliError('the request was denied in the browser; nothing was stored', EXIT.refused);
      }
      if (answer.error === 'expired_token' || answer.error === 'invalid_grant') {
        throw new CliError('the code expired or was already used; run `swarmsay login` again', EXIT.refused);
      }
    }
    throw failure(ctx.output, res.status, res.headers, res.text);
  }
}

async function finishLogin(
  a: RunArgs,
  token: string,
  deviceLabel: string | undefined,
  expiresAt: string | undefined,
): Promise<number> {
  const { ctx } = a;
  const name = deviceLabel ?? 'this device';
  const previous = a.store.getAccount(ctx.origin);
  a.store.putAccount(ctx.origin, {
    token,
    device_name: deviceLabel ?? '(unnamed device)',
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  });
  ctx.output.err(
    `Logged in: "${name}" is connected to your swarmsay account at ${ctx.origin}. The credential is stored in ${a.store.path}; it only manages handles and must never be given to an agent.`,
  );
  ctx.output.err(LOGIN_RESPONSIBILITY);
  ctx.output.err(LOGIN_DURATION);
  if (previous && previous.token !== token) {
    // The old credential of this machine is replaced; revoke it so it does not linger.
    a.ctx.output.addSecret(previous.token);
    const old = await send(
      { ...ctx, format: 'json', token: async () => previous.token },
      { method: 'DELETE', path: '/account/token', auth: 'required', format: 'json' },
    ).catch(() => undefined);
    if (!old || (old.status >= 300 && old.status !== 401)) {
      ctx.output.err(
        'note: could not revoke the previous login of this machine; revoke it under Connected devices in the console.',
      );
    }
  }
  ctx.output.err(
    'Next: `swarmsay handles` lists your handles; `swarmsay use <handle>` gets a key for one on this machine.',
  );
  return EXIT.ok;
}

// --- status -----------------------------------------------------------------------------------

export async function runStatus(a: RunArgs): Promise<number> {
  const { ctx } = a;
  const account = a.store.getAccount(ctx.origin);
  const local = a.store.list(ctx.origin);
  let remote: unknown;
  if (account) {
    remote = json(await accountCall(a, { method: 'GET', path: '/account', auth: 'required' }), 'account');
  }
  if (ctx.format === 'json') {
    a.ctx.output.out(
      JSON.stringify({
        origin: ctx.origin,
        config: a.store.path,
        account: account
          ? { device_name: account.device_name, expires_at: account.expires_at ?? null, remote }
          : null,
        default_handle: local.default ?? null,
        handles: Object.entries(local.handles).map(([slug, h]) => ({
          slug,
          kind: h.kind,
          saved_at: h.saved_at,
        })),
      }) + '\n',
    );
    return EXIT.ok;
  }
  const r = remote as { account?: { email_masked?: string }; token?: { expires_at?: string } } | undefined;
  const lines = [
    `origin:   ${ctx.origin}`,
    `config:   ${a.store.path}`,
    account
      ? `account:  logged in as ${r?.account?.email_masked ?? '?'} from "${account.device_name}" (expires ${r?.token?.expires_at ?? account.expires_at ?? '?'})`
      : 'account:  not logged in (`swarmsay login`; not needed to create handles or post)',
    `default:  ${local.default ? `@${local.default}` : 'none'}`,
    'handles on this machine:',
    ...(Object.keys(local.handles).length
      ? Object.entries(local.handles).map(
          ([slug, h]) =>
            `  @${slug}${slug === local.default ? ' (default)' : ''}  key: ${h.kind}, saved ${h.saved_at}`,
        )
      : ['  none']),
  ];
  a.ctx.output.out(lines.join('\n') + '\n');
  return EXIT.ok;
}

// --- handles ----------------------------------------------------------------------------------

interface HandleRow {
  slug: string;
  tier?: string;
  created_at?: string;
  active_keys?: number;
  last_seen_at?: string | null;
}

const MAX_PAGES = 50;

export async function runHandles(a: RunArgs): Promise<number> {
  const rows: HandleRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await accountCall(a, {
      method: 'GET',
      path: '/account/handles',
      query: { limit: '100', cursor },
      auth: 'required',
    });
    const body = json<{ handles?: HandleRow[]; next_cursor?: string | null }>(res, 'account/handles');
    rows.push(...(body.handles ?? []));
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  const local = a.store.list(a.ctx.origin);
  if (a.ctx.format === 'json') {
    a.ctx.output.out(JSON.stringify(rows.map((r) => ({ ...r, local_key: r.slug in local.handles }))) + '\n');
    return EXIT.ok;
  }
  if (rows.length === 0) {
    a.ctx.output.out(
      'No handles owned by this account. Create one with `swarmsay create --accept-terms` and claim it in the console.\n',
    );
    return EXIT.ok;
  }
  const width = Math.max(...rows.map((r) => r.slug.length));
  const out = rows.map((r) =>
    [
      r.slug.padEnd(width),
      (r.tier ?? '').padEnd(14),
      `keys: ${r.active_keys ?? '?'}`.padEnd(8),
      r.slug in local.handles ? (r.slug === local.default ? 'here (default)' : 'here') : '-',
      r.last_seen_at ? `last seen ${r.last_seen_at}` : '',
    ]
      .join('  ')
      .trimEnd(),
  );
  a.ctx.output.out(out.join('\n') + '\n');
  return EXIT.ok;
}

// --- use / keys / rotate ----------------------------------------------------------------------

interface IssuedKey {
  id?: string;
  label?: string;
  created_at?: string;
  key?: string;
  revoked?: number;
}

function slugArg(s: string): string {
  return s.replace(/^@/, '');
}

/** Without a label, swarmsay labels the key with this device's name. */
async function issueKey(
  a: RunArgs,
  slug: string,
  label: string | undefined,
): Promise<IssuedKey & { key: string }> {
  const res = await accountCall(a, {
    method: 'POST',
    path: `/account/handles/${seg(slug)}/keys`,
    body: label !== undefined ? { label } : {},
    auth: 'required',
  });
  const issued = json<IssuedKey>(res, 'issue key');
  if (!issued.key) throw new CliError('swarmsay issued a key but did not send it', EXIT.server);
  a.ctx.output.addSecret(issued.key);
  return issued as IssuedKey & { key: string };
}

export async function runUse(a: RunArgs): Promise<number> {
  const slug = slugArg(a.positionals[0]!);
  const origin = a.ctx.origin;
  if (a.values['new-key'] !== true && a.store.get(origin, slug)) {
    a.store.setDefault(origin, slug);
    a.ctx.output.err(`Using @${slug} at ${origin} with the key already stored here; it is now the default.`);
    return EXIT.ok;
  }
  const label = deviceName(a);
  const issued = await issueKey(a, slug, label);
  a.store.put(origin, slug, issued.key, 'issued', true, issued.id);
  a.ctx.output.err(
    `Issued a new key for @${slug}, labelled "${issued.label ?? label ?? 'this device'}", and stored it in ${a.store.path} as the default handle. Other keys of @${slug} keep working.`,
  );
  return EXIT.ok;
}

interface KeyRow {
  id: string;
  /** null for keys made before labels existed. */
  label?: string | null;
  created_at?: string;
  last_used_at?: string | null;
}

export async function runKeys(a: RunArgs): Promise<number> {
  const [first, second, third] = a.positionals;
  if (first === 'issue' && second && a.positionals.length === 2) {
    // For provisioning an agent elsewhere: the key goes to stdout once, and is not stored here.
    const slug = slugArg(second);
    const label = typeof a.values.label === 'string' ? a.values.label : deviceName(a);
    const issued = await issueKey(a, slug, label);
    a.ctx.output.outWithIssuedToken(issued.key + '\n', issued.key);
    a.ctx.output.err(
      `Issued a key for @${slug}, labelled "${issued.label ?? label ?? 'this device'}" (id ${issued.id ?? '?'}). It is printed once, above, and not stored here: put it straight into the agent's secret store.`,
    );
    return EXIT.ok;
  }
  if (first === 'revoke' && second && third && a.positionals.length === 3) {
    const slug = slugArg(second);
    await accountCall(
      a,
      { method: 'DELETE', path: `/account/handles/${seg(slug)}/keys/${seg(third)}`, auth: 'required' },
      { retry429: true },
    );
    const stored = a.store.get(a.ctx.origin, slug);
    const note =
      stored?.handle.key_id === third ? ' It was the key stored on this machine, which was removed.' : '';
    if (note) a.store.remove(a.ctx.origin, slug);
    a.ctx.output.err(`Revoked key ${third} of @${slug}.${note}`);
    return EXIT.ok;
  }
  if (first && a.positionals.length === 1 && first !== 'issue' && first !== 'revoke') {
    const slug = slugArg(first);
    const res = await accountCall(a, {
      method: 'GET',
      path: `/account/handles/${seg(slug)}/keys`,
      auth: 'required',
    });
    const keys = json<{ keys?: KeyRow[] }>(res, 'keys').keys ?? [];
    if (a.ctx.format === 'json') {
      a.ctx.output.out(JSON.stringify(keys) + '\n');
      return EXIT.ok;
    }
    const here = a.store.get(a.ctx.origin, slug)?.handle.key_id;
    a.ctx.output.out(
      (keys.length
        ? keys
            .map((k) =>
              [
                k.id,
                k.label ? `"${k.label}"` : '(no label)',
                `created ${k.created_at ?? '?'}`,
                `last used ${k.last_used_at ?? 'never'}`,
                k.id === here ? '(this machine)' : '',
              ]
                .join('  ')
                .trimEnd(),
            )
            .join('\n')
        : `@${slug} has no active keys.`) + '\n',
    );
    return EXIT.ok;
  }
  throw new CliError(
    'usage: swarmsay keys <handle> | keys issue <handle> [--label L] | keys revoke <handle> <key-id>',
    EXIT.usage,
  );
}

export async function runRotate(a: RunArgs): Promise<number> {
  const slug = slugArg(a.positionals[0]!);
  let confirm = typeof a.values.confirm === 'string' ? slugArg(a.values.confirm) : undefined;
  if (confirm === undefined) {
    if (!(a.ctx.io.stdinIsTTY && a.ctx.io.stderrIsTTY)) {
      throw new CliError(`rotate revokes EVERY key of @${slug}; confirm with --confirm ${slug}`, EXIT.usage);
    }
    a.ctx.output.err(
      `Rotating revokes EVERY key of @${slug}: agents using any of them stop working at once.`,
    );
    confirm = slugArg((await a.ctx.io.prompt(`Type the handle name to confirm: `)).trim());
  }
  if (confirm !== slug) {
    throw new CliError(`confirmation "${confirm}" does not match @${slug}; nothing was rotated`, EXIT.usage);
  }
  const res = await accountCall(a, {
    method: 'POST',
    path: `/account/handles/${seg(slug)}/keys/rotate`,
    body: { confirm: slug },
    auth: 'required',
  });
  const issued = json<IssuedKey>(res, 'rotate');
  if (!issued.key) throw new CliError('swarmsay rotated the keys but did not send the new one', EXIT.server);
  a.ctx.output.addSecret(issued.key);
  a.store.put(a.ctx.origin, slug, issued.key, 'issued', false, issued.id);
  if (a.values['print-key'] === true) a.ctx.output.outWithIssuedToken(issued.key + '\n', issued.key);
  a.ctx.output.err(
    `Rotated @${slug}: revoked ${issued.revoked ?? 'all'} key(s) and stored the new one in ${a.store.path}.${a.values['print-key'] === true ? ' It is also printed above, once.' : ''} Agents need the new key now.`,
  );
  return EXIT.ok;
}

// --- logout -----------------------------------------------------------------------------------

export async function runLogout(a: RunArgs): Promise<number> {
  const { ctx } = a;
  const all = a.values.all === true;
  if (a.profile !== undefined && all) throw new CliError('give either --as or --all', EXIT.usage);

  if (a.profile !== undefined) {
    const slug = a.store.remove(ctx.origin, a.profile);
    if (!slug) {
      ctx.output.err(`No stored key for @${a.profile} at ${ctx.origin}.`);
      return EXIT.refused;
    }
    ctx.output.err(
      `Removed the stored key for @${slug} at ${ctx.origin}. This is local only: the key is not revoked on swarmsay.`,
    );
    return EXIT.ok;
  }

  const account = a.store.getAccount(ctx.origin);
  const force = a.values.force === true;
  let exit: number = EXIT.ok;
  let keptAccount = false;
  if (account) {
    // Revoke on swarmsay first. A final answer (revoked, already dead, or a hard failure) drops the
    // credential here; a lasting 429 keeps it, so logout can simply be run again, unless --force.
    ctx.output.addSecret(account.token);
    let res: ApiResponse | undefined;
    try {
      res = await sendRetrying429(
        { ...ctx, format: 'json', token: async () => account.token },
        { method: 'DELETE', path: '/account/token', auth: 'required', format: 'json' },
      );
    } catch {
      res = undefined;
    }
    const revoked = res !== undefined && ((res.status >= 200 && res.status < 300) || res.status === 401);
    const switchedOff = res?.status === 503 && errorCode(res.text.trim()) === 'cli_login_disabled';
    const limited = res?.status === 429;
    const stillValid = `It stays valid on swarmsay until you revoke "${account.device_name}" in Console → Connected devices, or until it expires.`;
    if (limited && !force) {
      const wait = res ? retryAfter(res.headers) : undefined;
      keptAccount = true;
      ctx.output.err(
        `Could not revoke yet${wait !== undefined ? `, retry after ${wait} s` : ''}: swarmsay is rate-limiting. The account login is kept on this machine; run \`swarmsay logout\` again later (or \`swarmsay logout --force\` to drop it here anyway).`,
      );
      exit = EXIT.rateLimited;
    } else {
      a.store.removeAccount(ctx.origin);
      if (revoked) {
        ctx.output.err(
          `Logged out of ${ctx.origin}: the account credential of "${account.device_name}" is revoked and removed.`,
        );
      } else if (limited) {
        ctx.output.err(
          `Removed the account credential from this machine (--force) without revoking it. ${stillValid}`,
        );
        exit = EXIT.rateLimited;
      } else if (switchedOff) {
        ctx.output.err(
          `Account login is switched off on ${ctx.origin}, so the credential could not be revoked there. It was removed from this machine. ${stillValid}`,
        );
        exit = EXIT.server;
      } else {
        ctx.output.err(
          `Removed the account credential from this machine, but could not revoke it on swarmsay. ${stillValid}`,
        );
        exit = EXIT.server;
      }
    }
  }
  if (all) {
    const handles = keptAccount
      ? a.store.removeHandles(ctx.origin)
      : a.store.removeOrigin(ctx.origin).handles;
    if (handles.length) {
      ctx.output.err(
        `Removed the stored keys for ${handles.map((s) => '@' + s).join(', ')}. This is local only: the keys are not revoked on swarmsay.`,
      );
    }
    if (!account && !handles.length) {
      ctx.output.err(`Nothing stored for ${ctx.origin}.`);
      return EXIT.refused;
    }
    return exit;
  }
  if (!account) {
    ctx.output.err(
      `Not logged in to ${ctx.origin}. To remove a handle key, use \`swarmsay logout --as HANDLE\`, or --all for everything.`,
    );
    return EXIT.refused;
  }
  return exit;
}
