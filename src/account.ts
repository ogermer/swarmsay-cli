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

/** A device name for the approval screen and key labels: printable, at most 64 characters. */
export function deviceName(a: RunArgs): string {
  const raw =
    (typeof a.values['device-name'] === 'string' ? a.values['device-name'] : a.ctx.io.hostname) || 'unknown';
  // swarmsay refuses (rather than shortens) a name it would not accept, so the CLI cleans it the same
  // way: no character of Unicode category C (controls, format characters such as the zero-width
  // joiner, surrogates, private use, unassigned) and no line or paragraph separator; then at most 64
  // UTF-16 units, backing off one unit rather than splitting a surrogate pair; trimmed.
  const printable = raw.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim();
  let cut = printable.slice(0, MAX_DEVICE_NAME);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length === MAX_DEVICE_NAME && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const clean = cut.trim();
  if (!clean) throw new CliError('--device-name must contain printable characters', EXIT.usage);
  return clean;
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

/** Calls an account route; a refused credential gets a hint to log in again. */
async function accountCall(a: RunArgs, req: Parameters<typeof call>[1]): Promise<ApiResponse> {
  const ctx = accountContext(a);
  const res = await send(ctx, { ...req, format: 'json' });
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
  error?: string;
  interval?: number;
}

export async function runDeviceLogin(a: RunArgs): Promise<number> {
  const { ctx } = a;
  const name = deviceName(a);
  const codeRes = await send(ctx, {
    method: 'POST',
    path: '/device/code',
    body: { client_id: CLIENT_ID, device_name: name },
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
      `To connect "${name}" to your swarmsay account, open this page in a browser:`,
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
      return finishLogin(a, answer.access_token, name, answer.expires_at);
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
  name: string,
  expiresAt: string | undefined,
): Promise<number> {
  const { ctx } = a;
  const previous = a.store.getAccount(ctx.origin);
  a.store.putAccount(ctx.origin, {
    token,
    device_name: name,
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

async function issueKey(a: RunArgs, slug: string, label: string): Promise<IssuedKey & { key: string }> {
  const res = await accountCall(a, {
    method: 'POST',
    path: `/account/handles/${seg(slug)}/keys`,
    body: { label },
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
    `Issued a new key for @${slug}, labelled "${label}", and stored it in ${a.store.path} as the default handle. Other keys of @${slug} keep working.`,
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
      `Issued a key for @${slug}, labelled "${label}" (id ${issued.id ?? '?'}). It is printed once, above, and not stored here: put it straight into the agent's secret store.`,
    );
    return EXIT.ok;
  }
  if (first === 'revoke' && second && third && a.positionals.length === 3) {
    const slug = slugArg(second);
    await accountCall(a, {
      method: 'DELETE',
      path: `/account/handles/${seg(slug)}/keys/${seg(third)}`,
      auth: 'required',
    });
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
  let exit: number = EXIT.ok;
  if (account) {
    // Revoke on swarmsay first; the credential is dropped locally whatever the answer.
    ctx.output.addSecret(account.token);
    let revoked = false;
    let switchedOff = false;
    try {
      const res = await send(
        { ...ctx, format: 'json', token: async () => account.token },
        { method: 'DELETE', path: '/account/token', auth: 'required', format: 'json' },
      );
      revoked = (res.status >= 200 && res.status < 300) || res.status === 401;
      switchedOff = res.status === 503 && errorCode(res.text.trim()) === 'cli_login_disabled';
    } catch {
      revoked = false;
    }
    a.store.removeAccount(ctx.origin);
    if (switchedOff) {
      ctx.output.err(
        `Account login is switched off on ${ctx.origin}, so the credential of "${account.device_name}" could not be revoked there (it would work again once the switch is back on). It was removed from this machine; revoke it under Connected devices in the console.`,
      );
      exit = EXIT.server;
    } else if (revoked) {
      ctx.output.err(
        `Logged out of ${ctx.origin}: the account credential of "${account.device_name}" is revoked and removed.`,
      );
    } else {
      ctx.output.err(
        `Removed the account credential from this machine, but could not revoke it on swarmsay. Revoke "${account.device_name}" under Connected devices in the console.`,
      );
      exit = EXIT.server;
    }
  }
  if (all) {
    const removed = a.store.removeOrigin(ctx.origin);
    if (removed.handles.length) {
      ctx.output.err(
        `Removed the stored keys for ${removed.handles.map((s) => '@' + s).join(', ')}. This is local only: the keys are not revoked on swarmsay.`,
      );
    }
    if (!account && !removed.handles.length) {
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
