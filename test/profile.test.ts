import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, configPath } from '../src/config.js';
import {
  apiPath,
  fakeToken,
  harness,
  ORIGIN,
  type Handler,
  type Harness,
  type HarnessOptions,
  type Recorded,
  type Reply,
} from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const ETAG = '"v1-abc"';
const OWN = {
  notice: '# NOTICE: profile text is written by handles.',
  schemaVersion: 1,
  handle: 'scout-7',
  listing: 'unlisted',
  displayName: 'Scout',
  summary: 'Compares climate datasets.',
  topics: ['climate'],
  skills: [{ id: 'research', name: 'Research', description: 'Compare sources.', tags: ['research'] }],
  listingReadiness: { ready: true, missing: [] },
  moderation: [],
  updatedAt: '2026-10-06T10:00:00Z',
};
const EDITABLE = Object.fromEntries(
  Object.entries(OWN).filter(
    ([k]) =>
      !['notice', 'schemaVersion', 'handle', 'listingReadiness', 'moderation', 'updatedAt'].includes(k),
  ),
);

/** A server answering from a table "METHOD /path" → reply or handler; GET /profile answers OWN as JSON with an ETag. */
function server(
  routes: Record<string, Reply | ((req: Recorded) => Reply)> = {},
  opts: HarnessOptions = {},
): Harness {
  const handler: Handler = (req) => {
    const key = `${req.method} ${apiPath(req)}`;
    const r = routes[key];
    if (r) return typeof r === 'function' ? r(req) : r;
    if (key === 'GET /profile') {
      return req.url.searchParams.get('format') === 'json'
        ? { headers: { etag: ETAG, 'content-type': 'application/json' }, body: JSON.stringify(OWN) }
        : {
            headers: { etag: ETAG },
            body: '# swarmsay · profile @scout-7\netag: "v1-abc"\nsummary: Compares climate datasets.\n',
          };
    }
    return { status: 404, body: '# error: not_found\n' };
  };
  return harness({ env: { SWARMSAY_TOKEN: fakeToken() }, ...opts, handler });
}

const writes = () => h.calls.filter((c) => c.method !== 'GET');
const saved: Reply = { status: 200, body: '# swarmsay · profile @scout-7 saved\n' };

describe('profile: show', () => {
  it('own profile: GET /profile with the handle key, swarmsay text printed as is', async () => {
    h = server();
    expect(await h.run('profile')).toBe(0);
    expect(apiPath(h.calls[0]!)).toBe('/profile');
    expect(h.calls[0]!.headers.authorization).toMatch(/^Bearer sw_/);
    expect(h.stdout()).toContain('summary: Compares climate datasets.');
  });

  it("someone else's: GET /h/{slug} without a key", async () => {
    h = server({ 'GET /h/other': { body: '# swarmsay · @other\n' } });
    expect(await h.run('profile', 'show', '@other')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
    expect(h.stdout()).toBe('# swarmsay · @other\n');
  });
});

describe('profile: set, unset, list, unlist', () => {
  it('set FIELD VALUE: reads the ETag, then a merge patch with If-Match', async () => {
    h = server({ 'PATCH /profile': saved });
    expect(await h.run('profile', 'set', 'summary', 'Cites', 'its', 'sources.')).toBe(0);
    const w = writes()[0]!;
    expect(w.method).toBe('PATCH');
    expect(w.headers['content-type']).toBe('application/merge-patch+json');
    expect(w.headers['if-match']).toBe(ETAG);
    expect(JSON.parse(w.body!)).toEqual({ summary: 'Cites its sources.' });
    expect(h.stdout()).toBe('# swarmsay · profile @scout-7 saved\n');
  });

  it('a list field is split on commas and spaces', async () => {
    h = server({ 'PATCH /profile': saved });
    await h.run('profile', 'set', 'topics', 'climate,open-data', 'energy');
    expect(JSON.parse(writes()[0]!.body!)).toEqual({ topics: ['climate', 'open-data', 'energy'] });
  });

  it('a value from stdin with -', async () => {
    h = server({ 'PATCH /profile': saved }, { stdin: 'Line one.\n' });
    await h.run('profile', 'set', 'about', '-');
    expect(JSON.parse(writes()[0]!.body!)).toEqual({ about: 'Line one.' });
  });

  it('unset sends null; list and unlist set listing', async () => {
    h = server({ 'PATCH /profile': saved });
    await h.run('profile', 'unset', 'about');
    await h.run('profile', 'list');
    await h.run('profile', 'unlist');
    expect(writes().map((w) => JSON.parse(w.body!))).toEqual([
      { about: null },
      { listing: 'listed' },
      { listing: 'unlisted' },
    ]);
  });

  for (const argv of [
    ['profile', 'set', 'operator', 'robot'],
    ['profile', 'set', 'skills', 'x'],
    ['profile', 'set', 'summary'],
    ['profile', 'unset', 'handle'],
    ['profile', 'list', 'extra'],
    ['profile', 'frobnicate'],
  ]) {
    it(`${argv.join(' ')}: usage error, nothing sent`, async () => {
      h = server();
      expect(await h.run(...argv)).toBe(2);
      expect(writes()).toHaveLength(0);
    });
  }

  it('set --file replaces the whole profile with PUT and If-Match', async () => {
    h = server({ 'PUT /profile': saved });
    const file = join(h.home, 'p.json');
    writeFileSync(file, JSON.stringify({ summary: 'x', topics: ['a'] }));
    expect(await h.run('profile', 'set', '--file', file)).toBe(0);
    const w = writes()[0]!;
    expect([w.method, w.headers['if-match'], w.headers['content-type']]).toEqual([
      'PUT',
      ETAG,
      'application/json',
    ]);
    expect(JSON.parse(w.body!)).toEqual({ summary: 'x', topics: ['a'] });
  });

  it('set --file with invalid JSON: usage error, nothing sent', async () => {
    h = server();
    const file = join(h.home, 'p.json');
    writeFileSync(file, '{ not json');
    expect(await h.run('profile', 'set', '--file', file)).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  it('422: the field errors go to stderr, exit 1', async () => {
    const body =
      '# error: profile_invalid\nThe profile is not valid.\nsummary: Required to list.\ntopics: Required to list.\n';
    h = server({ 'PATCH /profile': { status: 422, body } });
    expect(await h.run('profile', 'list')).toBe(1);
    expect(h.stderr()).toContain('summary: Required to list.');
    expect(h.stdout()).toBe('');
  });

  it('412: nothing saved, and the CLI says so', async () => {
    h = server({
      'PATCH /profile': { status: 412, headers: { etag: '"v2"' }, body: '# error: profile_changed\n' },
    });
    expect(await h.run('profile', 'set', 'summary', 'x')).toBe(1);
    expect(h.stderr()).toMatch(/changed on swarmsay at the same moment; nothing was saved/);
  });
});

describe('profile edit', () => {
  /** An editor that records what it was given and rewrites the file. */
  function editor(edits: Array<(text: string) => string>) {
    const seen: Array<{ path: string; text: string; fileMode: number; dirMode: number }> = [];
    h.io.edit = async (path) => {
      const text = readFileSync(path, 'utf8');
      seen.push({
        path,
        text,
        fileMode: statSync(path).mode & 0o777,
        dirMode: statSync(dirname(path)).mode & 0o777,
      });
      const next = edits.shift();
      if (!next) throw new Error('editor opened too often');
      writeFileSync(path, next(text));
    };
    return seen;
  }
  const tty = { tty: true } as const;

  it('needs a terminal', async () => {
    h = server();
    expect(await h.run('profile', 'edit')).toBe(2);
    expect(h.stderr()).toMatch(/set --file/);
  });

  it('opens the editable fields in a private temporary file, saves with PUT and If-Match, removes the file', async () => {
    h = server({ 'PUT /profile': saved }, tty);
    const seen = editor([(t) => t.replace('Compares climate datasets.', 'Compares and cites.')]);
    expect(await h.run('profile', 'edit')).toBe(0);
    expect(JSON.parse(seen[0]!.text)).toEqual(EDITABLE);
    expect(seen[0]!.fileMode).toBe(0o600);
    expect(seen[0]!.dirMode).toBe(0o700);
    const w = writes()[0]!;
    expect([w.method, w.headers['if-match']]).toEqual(['PUT', ETAG]);
    expect(JSON.parse(w.body!).summary).toBe('Compares and cites.');
    expect(existsSync(dirname(seen[0]!.path))).toBe(false);
    expect(h.stdout()).toBe('# swarmsay · profile @scout-7 saved\n');
  });

  it('no change: nothing is sent', async () => {
    h = server({}, tty);
    const seen = editor([(t) => t]);
    expect(await h.run('profile', 'edit')).toBe(0);
    expect(writes()).toHaveLength(0);
    expect(h.stderr()).toMatch(/No changes/);
    expect(existsSync(dirname(seen[0]!.path))).toBe(false);
  });

  it('412: nothing overwritten; the edited version is kept in a private draft file, and the CLI says where', async () => {
    h = server(
      {
        'PUT /profile': {
          status: 412,
          headers: { etag: '"v2"' },
          body: '# error: profile_changed\netag: "v2"\n',
        },
      },
      tty,
    );
    const seen = editor([(t) => t.replace('Scout', 'Scout Two')]);
    expect(await h.run('profile', 'edit')).toBe(1);
    const drafts = join(dirname(configPath(h.io.env, h.home)), 'drafts');
    const [draft] = readdirSync(drafts);
    expect(readFileSync(join(drafts, draft!), 'utf8')).toContain('Scout Two');
    expect(statSync(join(drafts, draft!)).mode & 0o777).toBe(0o600);
    expect(statSync(drafts).mode & 0o777).toBe(0o700);
    expect(h.stderr()).toContain(join(drafts, draft!));
    expect(h.stderr()).toMatch(/nobody's changes were overwritten/);
    expect(existsSync(dirname(seen[0]!.path))).toBe(false);
  });

  it('422 at a terminal: shows the errors and reopens the editor on yes', async () => {
    const answers: Reply[] = [
      { status: 422, body: '# error: profile_invalid\ntopics[0]: invalid_format\n' },
      saved,
    ];
    h = server({ 'PUT /profile': () => answers.shift()! }, { tty: true, answers: [''] });
    const seen = editor([
      (t) => t.replace('"climate"', '"Climate!"'),
      (t) => t.replace('"Climate!"', '"climate-data"'),
    ]);
    expect(await h.run('profile', 'edit')).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.text).toContain('Climate!');
    expect(h.stderr()).toContain('topics[0]: invalid_format');
    expect(writes()).toHaveLength(2);
  });

  it('invalid JSON, then no: usage error, nothing sent, the file is gone', async () => {
    h = server({}, { tty: true, answers: ['n'] });
    const seen = editor([() => '{ broken']);
    expect(await h.run('profile', 'edit')).toBe(2);
    expect(writes()).toHaveLength(0);
    expect(existsSync(dirname(seen[0]!.path))).toBe(false);
  });

  it('an editor that fails still leaves no file behind', async () => {
    h = server({}, tty);
    let path = '';
    h.io.edit = async (p) => {
      path = p;
      throw new Error('the editor vi ended with exit code 1');
    };
    expect(await h.run('profile', 'edit')).not.toBe(0);
    expect(existsSync(dirname(path))).toBe(false);
  });
});

describe('skills', () => {
  it('lists the skills from the profile', async () => {
    h = server();
    expect(await h.run('skills')).toBe(0);
    expect(h.stdout()).toBe('research  Research  [research]\n  Compare sources.\n');
  });

  it('--json gives the list as JSON', async () => {
    h = server();
    await h.run('skills', '--json');
    expect(JSON.parse(h.stdout())).toEqual(OWN.skills);
  });

  it('add sends name, description, tags and examples', async () => {
    h = server({
      'POST /profile/skills': { status: 201, body: '# swarmsay · skill research-synthesis added\n' },
    });
    expect(
      await h.run(
        'skills',
        'add',
        'Research synthesis',
        '--desc',
        'Compare sources.',
        '--tag',
        'research',
        '--tag',
        'sources',
        '--example',
        'Compare A and B.',
      ),
    ).toBe(0);
    expect(JSON.parse(writes()[0]!.body!)).toEqual({
      name: 'Research synthesis',
      description: 'Compare sources.',
      tags: ['research', 'sources'],
      examples: ['Compare A and B.'],
    });
    expect(h.stdout()).toContain('research-synthesis');
  });

  it('add without --desc is a usage error', async () => {
    h = server();
    expect(await h.run('skills', 'add', 'X')).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  it('rm deletes by id with If-Match', async () => {
    h = server({ 'DELETE /profile/skills/research': { body: 'removed: research\n' } });
    expect(await h.run('skills', 'rm', 'research')).toBe(0);
    expect(writes()[0]!.headers['if-match']).toBe(ETAG);
  });

  it('too_many_skills is a refusal', async () => {
    h = server({ 'POST /profile/skills': { status: 409, body: '# error: too_many_skills\n' } });
    expect(await h.run('skills', 'add', 'X', '--desc', 'y')).toBe(1);
  });
});

describe('find', () => {
  it('passes the query and filters, with repeated topics; no key needed', async () => {
    h = harness({ handler: () => ({ body: '# swarmsay · discover\nmatched: topics=climate\n' }) });
    expect(
      await h.run(
        'find',
        'climate data',
        '--topic',
        'climate',
        '--topic',
        'open-data',
        '--lang',
        'en',
        '--operator',
        'agent',
        '--sort',
        'recent',
        '--limit',
        '5',
      ),
    ).toBe(0);
    const req = h.calls[0]!;
    expect(apiPath(req)).toBe('/discover');
    expect(req.url.searchParams.get('q')).toBe('climate data');
    expect(req.url.searchParams.getAll('topic')).toEqual(['climate', 'open-data']);
    expect(Object.fromEntries([...req.url.searchParams].filter(([k]) => k !== 'topic'))).toEqual({
      q: 'climate data',
      lang: 'en',
      operator: 'agent',
      sort: 'recent',
      limit: '5',
    });
    expect(req.headers.authorization).toBeUndefined();
    expect(h.stdout()).toContain('matched: topics=climate');
  });

  for (const argv of [
    ['find', '--operator', 'robot'],
    ['find', '--sort', 'popular'],
    ['find', '--limit', 'ten'],
  ]) {
    it(`${argv.slice(1).join(' ')}: usage error`, async () => {
      h = harness();
      expect(await h.run(...argv)).toBe(2);
      expect(h.calls).toHaveLength(0);
    });
  }
});

describe('account profile', () => {
  const OWN_ACCOUNT = {
    schemaVersion: 1,
    slug: 'ada',
    published: false,
    displayName: 'Ada',
    summary: 'x',
    publishReadiness: { ready: true, missing: [] },
  };
  function loggedIn(
    routes: Record<string, Reply | ((req: Recorded) => Reply)> = {},
    opts: HarnessOptions = {},
  ): string {
    const token = 'swa_' + fakeToken().slice(3);
    h = harness({
      ...opts,
      handler: (req) => {
        const key = `${req.method} ${apiPath(req)}`;
        const r = routes[key];
        if (r) return typeof r === 'function' ? r(req) : r;
        if (key === 'GET /account/profile') {
          return req.url.searchParams.get('format') === 'json'
            ? { headers: { etag: '"a1"' }, body: JSON.stringify(OWN_ACCOUNT) }
            : { headers: { etag: '"a1"' }, body: '# swarmsay · account profile\n' };
        }
        return { status: 404, body: '# error: not_found\n' };
      },
    });
    new ConfigStore(configPath(h.io.env, h.home)).putAccount(ORIGIN, { token, device_name: 'test-host' });
    return token;
  }

  it('not logged in: exit 3, nothing sent', async () => {
    h = harness();
    expect(await h.run('account', 'profile')).toBe(3);
    expect(h.calls).toHaveLength(0);
  });

  it('show: GET /account/profile with the account login', async () => {
    const token = loggedIn();
    expect(await h.run('account', 'profile')).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(h.stdout()).toBe('# swarmsay · account profile\n');
  });

  it('publish and unpublish: merge patch with If-Match', async () => {
    loggedIn({ 'PATCH /account/profile': { body: 'published\n' } });
    await h.run('account', 'profile', 'publish');
    await h.run('account', 'profile', 'unpublish');
    const w = h.calls.filter((c) => c.method === 'PATCH');
    expect(w.map((x) => JSON.parse(x.body!))).toEqual([{ published: true }, { published: false }]);
    expect(w[0]!.headers['if-match']).toBe('"a1"');
    expect(w[0]!.headers['content-type']).toBe('application/merge-patch+json');
  });

  it('set slug', async () => {
    loggedIn({ 'PATCH /account/profile': { body: 'ok\n' } });
    expect(await h.run('account', 'profile', 'set', 'slug', 'ada-lab')).toBe(0);
    expect(JSON.parse(h.calls.find((c) => c.method === 'PATCH')!.body!)).toEqual({ slug: 'ada-lab' });
  });

  it("show SLUG reads anyone's published profile without a login", async () => {
    h = harness({ handler: () => ({ body: '# swarmsay · Ada\n' }) });
    expect(await h.run('account', 'profile', 'show', 'ada')).toBe(0);
    expect(apiPath(h.calls[0]!)).toBe('/a/ada');
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('the account login is switched off: exit 5, the login is kept', async () => {
    const token = loggedIn({
      'GET /account/profile': {
        status: 503,
        body: JSON.stringify({ error: 'cli_login_disabled', message: 'x' }),
      },
    });
    expect(await h.run('account', 'profile')).toBe(5);
    expect(new ConfigStore(configPath(h.io.env, h.home)).getAccount(ORIGIN)?.token).toBe(token);
  });

  it('account without "profile" is a usage error', async () => {
    h = harness();
    expect(await h.run('account', 'show')).toBe(2);
  });
});
