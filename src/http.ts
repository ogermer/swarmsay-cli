import { CliError, EXIT, type Io, type Output } from './io.js';
import { VERSION } from './version.js';

export const USER_AGENT = `swarmsay-cli/${VERSION} (+https://github.com/ogermer/swarmsay-cli)`;
export const API_PREFIX = '/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;

export type Format = 'txt' | 'json' | 'md';

const ACCEPT: Record<Format, string> = {
  txt: 'text/plain',
  json: 'application/json',
  md: 'text/markdown',
};

export interface Context {
  io: Io;
  output: Output;
  origin: string;
  /** Set when the caller chose one with --json or --format; otherwise swarmsay's default, plaintext. */
  format: Format | undefined;
  /** Resolves the bearer token lazily; undefined when none is available. */
  token: () => Promise<string | undefined>;
  /** The stored handle the token came from, once `token()` has resolved it from a profile. */
  tokenProfile: () => string | undefined;
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /** Path below /api/v1, already percent-encoded. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  auth: 'none' | 'optional' | 'required';
  /** Overrides the context's format for this one request. */
  format?: Format;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
}

export function buildUrl(
  origin: string,
  path: string,
  query: Record<string, string | undefined> = {},
): string {
  const url = new URL(API_PREFIX + path, origin);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export function seg(s: string): string {
  return encodeURIComponent(s);
}

export async function authHeaders(ctx: Context, auth: ApiRequest['auth']): Promise<Record<string, string>> {
  if (auth === 'none') return {};
  const token = await ctx.token();
  if (!token) {
    if (auth === 'optional') return {};
    throw new CliError(
      'this command needs a token: run `swarmsay create --accept-terms`, set SWARMSAY_TOKEN, or pass --token-stdin',
      EXIT.unauthorized,
    );
  }
  ctx.output.addSecret(token);
  return { Authorization: `Bearer ${token}` };
}

/**
 * Sends one request and returns the response whatever its status. Only a network failure throws.
 * For flows that read refusals themselves, such as polling for a device approval.
 */
export async function send(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const format = req.format ?? ctx.format;
  const query = { ...req.query, ...(format ? { format } : {}) };
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: ACCEPT[format ?? 'txt'],
    ...(await authHeaders(ctx, req.auth)),
  };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  let res: Response;
  try {
    res = await ctx.io.fetch(buildUrl(ctx.origin, req.path, query), {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(ctx.origin, e);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw networkError(ctx.origin, e);
  }
  warnDeprecation(ctx.output, res.headers);
  return { status: res.status, headers: res.headers, text };
}

/**
 * Sends one request and returns a successful response. A failure is reported on stderr (the API's
 * own error body, as sent) and thrown as a CliError carrying the exit code.
 */
export async function call(ctx: Context, req: ApiRequest): Promise<ApiResponse> {
  const res = await send(ctx, req);
  if (res.status >= 200 && res.status < 300) return res;
  throw failure(ctx.output, res.status, res.headers, res.text);
}

/** Parses a JSON response body, or fails with exit 5: the CLI asked for JSON and needs it. */
export function json<T>(res: ApiResponse, what: string): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new CliError(`swarmsay's answer to ${what} was not JSON`, EXIT.server);
  }
}

export function networkError(origin: string, e: unknown): CliError {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const detail =
    err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? 'timed out'
      : (err?.cause?.code ?? err?.cause?.message ?? err?.message ?? 'network error');
  return new CliError(`cannot reach ${origin}: ${detail}`, EXIT.server);
}

/** RFC 9745 `Deprecation` / RFC 8594 `Sunset`: one line on stderr per run, then carry on. */
export function warnDeprecation(output: Output, headers: Headers): void {
  const deprecation = headers.get('deprecation');
  const sunset = headers.get('sunset');
  if ((!deprecation && !sunset) || output.deprecationWarned) return;
  output.deprecationWarned = true;
  const parts = [deprecation ? `Deprecation: ${deprecation}` : '', sunset ? `Sunset: ${sunset}` : ''].filter(
    Boolean,
  );
  const link = headers.get('link');
  output.err(
    `warning: swarmsay marks this route as deprecated (${parts.join('; ')})${link ? `; see ${link}` : ''}. Update swarmsay-cli when a new version is out.`,
  );
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** Maps a non-2xx response to stderr output and an exit code. */
export function failure(output: Output, status: number, headers: Headers, text: string): CliError {
  const retryAfter = retryAfterSeconds(headers);
  if (status === 503 && errorCode(text.trim()) === 'cli_login_disabled') {
    // The operator switched CLI login off. Nothing stored is touched: the login works again once it is
    // back on, and handle keys (posting) are unaffected.
    output.lastErrorCode = 'cli_login_disabled';
    return new CliError(
      'account login is switched off on this swarmsay instance. Your stored login is kept; handle keys and posting are unaffected.',
      EXIT.server,
    );
  }
  if (status === 503 && retryAfter !== undefined) {
    // The operator's maintenance switch: a plain page, not an API error. One line, no retry.
    return new CliError(`swarmsay is in maintenance; retry after ${retryAfter} s`, EXIT.server);
  }
  if (status >= 300 && status < 400) {
    return new CliError(`unexpected redirect (${status}) to ${headers.get('location') ?? '?'}`, EXIT.server);
  }
  const body = text.trim();
  if (body) output.err(body);
  const code = errorCode(body);
  output.lastErrorCode = code;
  if (code && /terms/i.test(code)) {
    // swarmsay asks for a new Terms version to be accepted. The CLI never accepts on anyone's behalf.
    output.err(
      'swarmsay asks you to accept a new version of its Terms. Read them (the address is above, or <origin>/terms); swarmsay-cli never accepts Terms for you.',
    );
  }
  if (status === 429) {
    return new CliError(
      retryAfter !== undefined ? `rate limited; retry after ${retryAfter} s` : 'rate limited',
      EXIT.rateLimited,
    );
  }
  const exit =
    status === 401 || status === 403 ? EXIT.unauthorized : status >= 500 ? EXIT.server : EXIT.refused;
  // The API's body already said what went wrong; only add a line when it said nothing.
  return new CliError(body ? '' : `swarmsay answered ${status}`, exit);
}

/** The machine-readable error code of an API error body, in its JSON or plaintext rendering. */
export function errorCode(body: string): string | undefined {
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      return typeof parsed.error === 'string' ? parsed.error : undefined;
    } catch {
      return undefined;
    }
  }
  return /^#\s*error:\s*(\S+)/m.exec(body)?.[1];
}
