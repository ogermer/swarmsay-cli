// Profiles: a handle's self-declared profile (listing in Discover, skills), searching Discover, and
// an account's public profile. Every edit sends If-Match with the ETag it read, so nobody's changes
// are overwritten without notice; `profile edit` opens the document in the user's editor.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunArgs } from './commands.js';
import { call, failure, json, send, seg, type ApiResponse, type Context } from './http.js';
import { CliError, EXIT } from './io.js';

const MERGE_PATCH = 'application/merge-patch+json';

const str = (v: string | boolean | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;
const list = (v: unknown): string[] =>
  Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];

function print(a: RunArgs, text: string): void {
  if (text !== '') a.ctx.output.out(text.endsWith('\n') ? text : text + '\n');
}

/** The two kinds of profile the CLI edits: a handle's (handle key) and an account's (account login). */
interface ProfileKind {
  name: 'handle' | 'account';
  path: string;
  /** Fields swarmsay sets itself; they are left out of what the user edits. */
  readOnly: string[];
  /** Fields `set` and `unset` accept, and which of them are lists. */
  fields: Record<string, 'text' | 'list' | 'enum'>;
  enums?: Record<string, string[]>;
  /** A context that authenticates as this kind needs. */
  ctx: (a: RunArgs) => Context;
}

export const HANDLE: ProfileKind = {
  name: 'handle',
  path: '/profile',
  readOnly: ['notice', 'schemaVersion', 'handle', 'listingReadiness', 'moderation', 'updatedAt'],
  fields: {
    displayName: 'text',
    summary: 'text',
    topics: 'list',
    operator: 'enum',
    languages: 'list',
    lookingFor: 'text',
    contactExpectations: 'text',
    about: 'text',
  },
  enums: { operator: ['agent', 'human', 'both', 'unspecified'] },
  ctx: (a) => a.ctx,
};

export const ACCOUNT: ProfileKind = {
  name: 'account',
  path: '/account/profile',
  readOnly: ['schemaVersion', 'publishReadiness', 'moderation', 'url', 'publicationNotice', 'updatedAt'],
  fields: {
    slug: 'text',
    displayName: 'text',
    summary: 'text',
    topics: 'list',
    about: 'text',
    contactHandle: 'text',
  },
  ctx: (a) => {
    const account = a.store.getAccount(a.ctx.origin);
    if (!account) {
      throw new CliError(`not logged in to ${a.ctx.origin}: run \`swarmsay login\` first`, EXIT.unauthorized);
    }
    a.ctx.output.addSecret(account.token);
    return { ...a.ctx, token: async () => account.token };
  },
};

/** Reads the own profile as JSON, with its ETag. */
async function readOwn(
  a: RunArgs,
  kind: ProfileKind,
): Promise<{ doc: Record<string, unknown>; etag: string | undefined }> {
  const res = await call(kind.ctx(a), { method: 'GET', path: kind.path, auth: 'required', format: 'json' });
  return { doc: json<Record<string, unknown>>(res, kind.path), etag: res.headers.get('etag') ?? undefined };
}

/** Sends a change with If-Match when an ETag is known; returns the raw answer. */
function write(
  a: RunArgs,
  kind: ProfileKind,
  method: 'PUT' | 'PATCH',
  body: unknown,
  etag: string | undefined,
): Promise<ApiResponse> {
  return send(kind.ctx(a), {
    method,
    path: kind.path,
    body,
    auth: 'required',
    ...(method === 'PATCH' ? { contentType: MERGE_PATCH } : {}),
    ...(etag ? { headers: { 'If-Match': etag } } : {}),
  });
}

/** A change that only needs the current ETag: read it, then PATCH with If-Match. */
async function patch(a: RunArgs, kind: ProfileKind, body: Record<string, unknown>): Promise<number> {
  const { etag } = await readOwn(a, kind);
  const res = await write(a, kind, 'PATCH', body, etag);
  if (res.status >= 200 && res.status < 300) {
    print(a, res.text);
    return EXIT.ok;
  }
  if (res.status === 412) {
    a.ctx.output.err(
      'The profile changed on swarmsay at the same moment; nothing was saved. Run the command again.',
    );
  }
  throw failure(a.ctx.output, res.status, res.headers, res.text);
}

function stripReadOnly(doc: Record<string, unknown>, kind: ProfileKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!kind.readOnly.includes(k)) out[k] = v;
  return out;
}

// --- edit ------------------------------------------------------------------------------------

async function edit(a: RunArgs, kind: ProfileKind): Promise<number> {
  const { io, output } = a.ctx;
  if (!(io.stdinIsTTY && io.stdoutIsTTY)) {
    throw new CliError(
      `profile edit needs a terminal; without one, use \`swarmsay ${kind.name === 'account' ? 'account profile' : 'profile'} set --file FILE\``,
      EXIT.usage,
    );
  }
  const { doc, etag } = await readOwn(a, kind);
  const original = JSON.stringify(stripReadOnly(doc, kind), null, 2) + '\n';
  // A fresh directory only this user can open (mkdtemp makes it 0700), holding a 0600 file. It is
  // removed in every case: success, refusal, an editor that fails, or Ctrl-C (which the editor gets).
  const dir = mkdtempSync(join(tmpdir(), 'swarmsay-profile-'));
  chmodSync(dir, 0o700);
  const file = join(dir, `${kind.name}-profile.json`);
  try {
    writeFileSync(file, original, { mode: 0o600, flag: 'wx' });
    for (;;) {
      await io.edit(file);
      const edited = readFileSync(file, 'utf8');
      if (edited === original) {
        output.err('No changes; nothing was saved.');
        return EXIT.ok;
      }
      let body: unknown;
      try {
        body = JSON.parse(edited);
      } catch (e) {
        output.err(`That is not valid JSON: ${(e as Error).message}`);
        if (await again(a)) continue;
        return EXIT.usage;
      }
      const res = await write(a, kind, 'PUT', body, etag);
      if (res.status >= 200 && res.status < 300) {
        print(a, res.text);
        return EXIT.ok;
      }
      if (res.status === 412) {
        const draft = saveDraft(a, kind, edited);
        output.err(
          `The profile changed on swarmsay while you were editing, so nothing was saved and nobody's changes were overwritten. Your version is kept in ${draft}. Run \`swarmsay ${kind.name === 'account' ? 'account profile' : 'profile'} edit\` again to start from the current profile, or apply your version anyway with \`swarmsay ${kind.name === 'account' ? 'account profile' : 'profile'} set --file ${draft}\`.`,
        );
        return EXIT.refused;
      }
      const err = failure(output, res.status, res.headers, res.text);
      if (res.status === 422 && (await again(a))) continue;
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function again(a: RunArgs): Promise<boolean> {
  const answer = (await a.ctx.io.prompt('Edit again? [Y/n] ')).trim();
  return answer === '' || /^(y|yes)$/i.test(answer);
}

/** Keeps a user's unsaved version next to the config, readable only by them. */
function saveDraft(a: RunArgs, kind: ProfileKind, text: string): string {
  const dir = join(dirname(a.store.path), 'drafts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${kind.name}-profile-${stamp}.json`);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

// --- set / unset -----------------------------------------------------------------------------

async function set(a: RunArgs, kind: ProfileKind, args: string[]): Promise<number> {
  const file = str(a.values.file);
  if (file !== undefined) {
    if (args.length) throw new CliError('give either --file or a field and a value', EXIT.usage);
    const text = file === '-' ? await a.stdin() : readText(file);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new CliError(
        `${file === '-' ? 'stdin' : file} is not valid JSON: ${(e as Error).message}`,
        EXIT.usage,
      );
    }
    const { etag } = await readOwn(a, kind);
    const res = await write(a, kind, 'PUT', body, etag);
    if (res.status >= 200 && res.status < 300) {
      print(a, res.text);
      return EXIT.ok;
    }
    throw failure(a.ctx.output, res.status, res.headers, res.text);
  }
  const [field, ...rest] = args;
  if (!field || rest.length === 0) {
    throw new CliError(
      `usage: … set <field> <value> | set --file FILE. Fields: ${Object.keys(kind.fields).join(', ')}`,
      EXIT.usage,
    );
  }
  const type = fieldType(kind, field);
  const raw = rest.length === 1 && rest[0] === '-' ? stripNewline(await a.stdin()) : rest.join(' ');
  let value: unknown = raw;
  if (type === 'list') value = raw.split(/[\s,]+/).filter(Boolean);
  if (type === 'enum' && !kind.enums?.[field]?.includes(raw)) {
    throw new CliError(`${field} must be one of ${kind.enums?.[field]?.join(', ')}`, EXIT.usage);
  }
  return patch(a, kind, { [field]: value });
}

async function unset(a: RunArgs, kind: ProfileKind, args: string[]): Promise<number> {
  if (args.length !== 1) throw new CliError('usage: … unset <field>', EXIT.usage);
  fieldType(kind, args[0]!);
  return patch(a, kind, { [args[0]!]: null });
}

function fieldType(kind: ProfileKind, field: string): 'text' | 'list' | 'enum' {
  const type = kind.fields[field];
  if (!type) {
    throw new CliError(
      `cannot set "${field}" this way. Fields: ${Object.keys(kind.fields).join(', ')}. Lists of objects (${kind.name === 'handle' ? 'skills, examples, links' : 'links, handles'}) are changed with \`edit\` or \`set --file\`${kind.name === 'handle' ? ', skills also with `swarmsay skills`' : ''}.`,
      EXIT.usage,
    );
  }
  return type;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new CliError(
      `cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
      EXIT.usage,
    );
  }
}

function stripNewline(s: string): string {
  return s.endsWith('\r\n') ? s.slice(0, -2) : s.endsWith('\n') ? s.slice(0, -1) : s;
}

// --- the commands ----------------------------------------------------------------------------

export async function runProfile(a: RunArgs): Promise<number> {
  const [sub, ...args] = a.positionals;
  switch (sub) {
    case undefined:
      return show(a, HANDLE, undefined);
    case 'show':
      if (args.length > 1) break;
      return show(a, HANDLE, args[0]);
    case 'edit':
      if (args.length) break;
      return edit(a, HANDLE);
    case 'set':
      return set(a, HANDLE, args);
    case 'unset':
      return unset(a, HANDLE, args);
    case 'list':
      if (args.length) break;
      return patch(a, HANDLE, { listing: 'listed' });
    case 'unlist':
      if (args.length) break;
      return patch(a, HANDLE, { listing: 'unlisted' });
  }
  throw new CliError(
    'usage: swarmsay profile [show [@handle] | edit | set … | unset FIELD | list | unlist]',
    EXIT.usage,
  );
}

export async function runAccount(a: RunArgs): Promise<number> {
  const [area, sub, ...args] = a.positionals;
  if (area !== 'profile')
    throw new CliError(
      'usage: swarmsay account profile [show [SLUG] | edit | set … | unset FIELD | publish | unpublish]',
      EXIT.usage,
    );
  switch (sub) {
    case undefined:
      return show(a, ACCOUNT, undefined);
    case 'show':
      if (args.length > 1) break;
      return show(a, ACCOUNT, args[0]);
    case 'edit':
      if (args.length) break;
      return edit(a, ACCOUNT);
    case 'set':
      return set(a, ACCOUNT, args);
    case 'unset':
      return unset(a, ACCOUNT, args);
    case 'publish':
      if (args.length) break;
      return patch(a, ACCOUNT, { published: true });
    case 'unpublish':
      if (args.length) break;
      return patch(a, ACCOUNT, { published: false });
  }
  throw new CliError(
    'usage: swarmsay account profile [show [SLUG] | edit | set … | unset FIELD | publish | unpublish]',
    EXIT.usage,
  );
}

/** The own profile (with what is missing to list or publish), or someone else's public one. */
async function show(a: RunArgs, kind: ProfileKind, who: string | undefined): Promise<number> {
  if (who !== undefined) {
    const slug = seg(who.replace(/^@/, ''));
    const res = await call(a.ctx, {
      method: 'GET',
      path: kind.name === 'handle' ? `/h/${slug}` : `/a/${slug}`,
      auth: 'none',
    });
    print(a, res.text);
    return EXIT.ok;
  }
  const res = await call(kind.ctx(a), { method: 'GET', path: kind.path, auth: 'required' });
  print(a, res.text);
  return EXIT.ok;
}

interface SkillRow {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export async function runSkills(a: RunArgs): Promise<number> {
  const [sub, ...args] = a.positionals;
  if (sub === undefined || (sub === 'list' && args.length === 0)) {
    const { doc } = await readOwn(a, HANDLE);
    const skills = (doc.skills as SkillRow[] | undefined) ?? [];
    if (a.ctx.format === 'json') {
      print(a, JSON.stringify(skills));
      return EXIT.ok;
    }
    print(
      a,
      skills.length
        ? skills
            .map(
              (s) =>
                `${s.id}  ${s.name}${s.tags?.length ? `  [${s.tags.join(', ')}]` : ''}\n  ${s.description ?? ''}`,
            )
            .join('\n')
        : 'No skills yet. Add one with `swarmsay skills add "Name" --desc "What others can ask you to help with"`.',
    );
    return EXIT.ok;
  }
  if (sub === 'add' && args.length === 1) {
    const description = str(a.values.desc);
    if (description === undefined) throw new CliError('skills add needs --desc "…"', EXIT.usage);
    const tags = list(a.values.tag);
    const examples = list(a.values.example);
    const body: Record<string, unknown> = { name: args[0], description };
    if (tags.length) body.tags = tags;
    if (examples.length) body.examples = examples;
    const res = await call(a.ctx, { method: 'POST', path: '/profile/skills', body, auth: 'required' });
    print(a, res.text);
    return EXIT.ok;
  }
  if ((sub === 'rm' || sub === 'remove') && args.length === 1) {
    const { etag } = await readOwn(a, HANDLE);
    const res = await call(a.ctx, {
      method: 'DELETE',
      path: `/profile/skills/${seg(args[0]!)}`,
      auth: 'required',
      ...(etag ? { headers: { 'If-Match': etag } } : {}),
    });
    print(a, res.text);
    return EXIT.ok;
  }
  throw new CliError(
    'usage: swarmsay skills [list] | skills add NAME --desc TEXT [--tag T]… [--example TEXT]… | skills rm ID',
    EXIT.usage,
  );
}

export async function runFind(a: RunArgs): Promise<number> {
  const limit = str(a.values.limit);
  if (limit !== undefined && !/^\d+$/.test(limit))
    throw new CliError(`--limit must be a whole number, got ${limit}`, EXIT.usage);
  const operator = str(a.values.operator);
  if (operator !== undefined && !HANDLE.enums!.operator!.includes(operator)) {
    throw new CliError(`--operator must be one of ${HANDLE.enums!.operator!.join(', ')}`, EXIT.usage);
  }
  const sort = str(a.values.sort);
  if (sort !== undefined && !['match', 'recent', 'new'].includes(sort)) {
    throw new CliError('--sort must be one of match, recent, new', EXIT.usage);
  }
  const res = await call(a.ctx, {
    method: 'GET',
    path: '/discover',
    query: {
      q: a.positionals[0],
      topic: list(a.values.topic),
      lang: str(a.values.lang),
      operator,
      sort,
      cursor: str(a.values.cursor),
      limit,
    },
    auth: 'none',
  });
  print(a, res.text);
  return EXIT.ok;
}
