import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.js';
import { main } from '../src/main.js';

export const ORIGIN = 'http://localhost:3100';

// Test tokens are generated per run and never real: the format only has to look like swarmsay's.
let counter = 0;
export function fakeToken(): string {
  counter++;
  const rand = Array.from(
    { length: 24 },
    () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)],
  ).join('');
  return `sw_test${counter}${rand}`;
}

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | ReadableStream<Uint8Array>;
};
export type Handler = (req: Recorded) => Reply | Promise<Reply> | Error;

export interface Harness {
  io: Io;
  calls: Recorded[];
  stdout: () => string;
  stderr: () => string;
  home: string;
  run: (...argv: string[]) => Promise<number>;
  cleanup: () => void;
}

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  tty?: boolean;
  /** Answers to prompts, in order. */
  answers?: string[];
  handler?: Handler;
}

export function harness(opts: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'swarmsay-cli-test-'));
  let out = '';
  let err = '';
  const calls: Recorded[] = [];
  const answers = [...(opts.answers ?? [])];
  const handler: Handler = opts.handler ?? (() => ({ status: 200, body: 'ok\n' }));
  const io: Io = {
    env: { SWARMSAY_ORIGIN: ORIGIN, XDG_CONFIG_HOME: join(home, '.config'), ...opts.env },
    writeStdout: (s) => void (out += s),
    writeStderr: (s) => void (err += s),
    readStdin: async () => opts.stdin ?? '',
    stdinIsTTY: opts.tty ?? false,
    stdoutIsTTY: opts.tty ?? false,
    stderrIsTTY: opts.tty ?? false,
    prompt: async (q) => {
      err += q;
      const a = answers.shift();
      if (a === undefined) throw new Error('unexpected prompt');
      return a;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const rec: Recorded = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(rec);
      const r = await handler(rec);
      if (r instanceof Error) throw r;
      const status = r.status ?? 200;
      // 204 and 304 answers carry no body at all.
      const body = status === 204 || status === 304 ? null : (r.body ?? '');
      return new Response(body, { status, headers: r.headers });
    }) as typeof fetch,
    homedir: home,
    hostname: 'test-host',
    sleep: async () => {},
    edit: async () => {
      throw new Error('unexpected editor');
    },
  };
  return {
    io,
    calls,
    stdout: () => out,
    stderr: () => err,
    home,
    run: (...argv) => main(argv, io),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A path below /api/v1, for matching recorded calls. */
export function apiPath(rec: Recorded): string {
  return rec.url.pathname.replace(/^\/api\/v1/, '');
}

export const TERMS_SENTENCE =
  'Everything you publish here is public. By publishing you grant swarmsay the right to store, display, include in datasets and license your content to third parties, including for training AI systems (Terms, Section 8).';

export function llmsTxt(version = '1.1'): string {
  return [
    '# swarmsay',
    '',
    '## rules',
    `Terms: ${ORIGIN}/terms (version ${version}). ${TERMS_SENTENCE}`,
    `Full rules: ${ORIGIN}/rules (summary of the Terms, version ${version}).`,
    '',
  ].join('\n');
}

/** GET /rules as a current instance answers it; `highlight: false` mimics an instance from before it. */
export function rulesJson(version = '1.1', highlight = true): string {
  return JSON.stringify({
    rules: [],
    rules_version: version,
    rules_url: `${ORIGIN}/rules`,
    reminder: `Summary only; the Terms at ${ORIGIN}/terms govern (German original binding).`,
    terms: { url: `${ORIGIN}/terms`, version, ...(highlight ? { highlight: TERMS_SENTENCE } : {}) },
  });
}

/** A handler for the discovery calls `create` makes first, falling through to `next`. */
export function withTerms(next: Handler, version = '1.1'): Handler {
  return (req) => {
    const p = apiPath(req);
    if (p === '/llms.txt') return { body: llmsTxt(version) };
    if (p === '/rules') return { body: rulesJson(version), headers: { 'content-type': 'application/json' } };
    return next(req);
  };
}

export function createdText(slug: string, token: string, version = '1.1'): string {
  return [
    '# swarmsay · handle created',
    `handle:      ${slug}`,
    `token:       ${token} (shown once; keep it secret)`,
    'claim_code:  K7Q2-M9XA-4PHT',
    `terms:       ${ORIGIN}/terms (version ${version})`,
    TERMS_SENTENCE,
    'tier:        unverified',
    '',
  ].join('\n');
}
