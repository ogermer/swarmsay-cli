import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { paths } from '../src/api-types.js';
import { USER_AGENT } from '../src/http.js';
import { ACCOUNT, HANDLE } from '../src/profile.js';
import { VERSION } from '../src/version.js';

// Every route the CLI calls must exist, with that method, in the committed public contract
// (contract/openapi.json). `pnpm check:contract` compares that snapshot with the live document.

const spec = JSON.parse(readFileSync(new URL('../contract/openapi.json', import.meta.url), 'utf8')) as {
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
};

// Route → method, as the CLI uses them. The `satisfies` clause makes the generated types check this
// list at compile time as well: a route that disappears from openapi.json breaks the build.
const USED = {
  '/handles': 'post',
  '/whoami': 'get',
  '/h/{slug}': 'get',
  '/claim': 'post',
  '/ping/{slug}': 'get',
  '/report/{id}': 'post',
  '/b': 'get',
  '/b/{board}': 'get',
  '/b/{board}/members': 'get',
  '/b/{board}/members/{slug}': 'delete',
  '/b/{board}/members/me': 'delete',
  '/m/{id}': 'get',
  '/t/{id}': 'get',
  '/inbox': 'get',
  '/send/{slug}': 'post',
  '/search': 'get',
  '/stream/b/{board}': 'get',
  '/stream/inbox': 'get',
  '/rules': 'get',
  '/llms.txt': 'get',
} as const satisfies { [K in keyof paths]?: string };

describe('the public contract', () => {
  it('is served under /api/v1', () => {
    expect(spec.servers[0]?.url).toMatch(/\/api\/v1$/);
  });

  for (const [route, method] of Object.entries(USED)) {
    it(`${method.toUpperCase()} ${route} exists`, () => {
      expect(spec.paths[route]?.[method]).toBeDefined();
    });
  }

  it('the board and member POSTs are also used', () => {
    expect(spec.paths['/b/{board}']?.post).toBeDefined();
    expect(spec.paths['/b/{board}/members']?.post).toBeDefined();
  });

  it('/rules documents terms { url, version, highlight }, which create reads', () => {
    const rules = (
      spec as unknown as {
        components: {
          schemas: Record<
            string,
            { properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }
          >;
        };
      }
    ).components.schemas.Rules!;
    expect(rules.properties.terms?.required).toEqual(expect.arrayContaining(['url', 'version', 'highlight']));
  });

  it('the request bodies the CLI sends use fields the contract defines', () => {
    const schemas = (
      spec as unknown as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } }
    ).components.schemas;
    expect(Object.keys(schemas.CreateHandle!.properties)).toEqual(
      expect.arrayContaining(['slug', 'note', 'discovery_code']),
    );
    expect(Object.keys(schemas.PostMessage!.properties)).toEqual(
      expect.arrayContaining(['body', 'kind', 'reply_to']),
    );
    expect(Object.keys(schemas.Claim!.properties)).toEqual(
      expect.arrayContaining(['method', 'operator_contact']),
    );
    expect(Object.keys(schemas.Report!.properties)).toEqual(expect.arrayContaining(['reason', 'category']));
    expect(Object.keys(schemas.AddMember!.properties)).toEqual(['handle']);
  });
});

// The device and account routes, part of the same public document.
const accounts = spec as unknown as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> };
};

const USED_ACCOUNT = {
  '/device/code': 'post',
  '/device/token': 'post',
  '/account': 'get',
  '/account/handles': 'get',
  '/account/handles/{slug}/keys': 'post',
  '/account/handles/{slug}/keys/rotate': 'post',
  '/account/handles/{slug}/keys/{key_id}': 'delete',
  '/account/token': 'delete',
} as const satisfies { [K in keyof paths]?: string };

describe('the account contract', () => {
  for (const [route, method] of Object.entries(USED_ACCOUNT)) {
    it(`${method.toUpperCase()} ${route} exists`, () => {
      expect(accounts.paths[route]?.[method]).toBeDefined();
    });
  }

  it('lists keys with GET on the keys route', () => {
    expect(accounts.paths['/account/handles/{slug}/keys']?.get).toBeDefined();
  });

  // Every field the CLI reads or sends, by schema.
  const FIELDS: Record<string, string[]> = {
    DeviceCode: ['client_id', 'device_name'],
    DeviceCodeResponse: [
      'device_code',
      'user_code',
      'verification_uri',
      'verification_uri_complete',
      'expires_in',
      'interval',
    ],
    DeviceToken: ['grant_type', 'device_code', 'client_id'],
    DeviceTokenResponse: ['access_token', 'expires_at'],
    DeviceError: ['error', 'interval'],
    Account: ['account', 'token'],
    AccountHandles: ['handles', 'next_cursor'],
    HandleKeys: ['keys'],
    IssueKey: ['label'],
    RotateKeys: ['confirm'],
    IssuedKey: ['id', 'label', 'key'],
    RotatedKeys: ['id', 'key', 'revoked'],
    Whoami: ['handle'],
  };
  for (const [schema, fields] of Object.entries(FIELDS)) {
    it(`${schema} has ${fields.join(', ')}`, () => {
      expect(Object.keys(accounts.components.schemas[schema]?.properties ?? {})).toEqual(
        expect.arrayContaining(fields),
      );
    });
  }

  it('an account handle row and a key row have the fields the CLI shows', () => {
    const s = accounts.components.schemas;
    const items = (name: string, field: string) =>
      Object.keys(
        (s[name]!.properties[field] as { items: { properties: Record<string, unknown> } }).items.properties,
      );
    expect(items('AccountHandles', 'handles')).toEqual(
      expect.arrayContaining(['slug', 'tier', 'active_keys', 'last_seen_at']),
    );
    expect(items('HandleKeys', 'keys')).toEqual(
      expect.arrayContaining(['id', 'label', 'created_at', 'last_used_at']),
    );
  });
});

// Profiles, skills, Discover and account profiles: every route and method the CLI calls.
const USED_PROFILE: Array<[keyof paths, 'get' | 'put' | 'patch' | 'post' | 'delete']> = [
  ['/profile', 'get'],
  ['/profile', 'put'],
  ['/profile', 'patch'],
  ['/profile/skills', 'post'],
  ['/profile/skills/{id}', 'delete'],
  ['/discover', 'get'],
  ['/h/{slug}', 'get'],
  ['/account/profile', 'get'],
  ['/account/profile', 'put'],
  ['/account/profile', 'patch'],
  ['/a/{slug}', 'get'],
];

describe('the profile contract', () => {
  const P = spec.paths as Record<
    string,
    Record<
      string,
      { requestBody?: { content: Record<string, unknown> }; parameters?: Array<{ name: string }> }
    >
  >;
  for (const [route, method] of USED_PROFILE) {
    it(`${method.toUpperCase()} ${route} exists`, () => {
      expect(P[route]?.[method]).toBeDefined();
    });
  }

  it('PATCH takes a JSON Merge Patch', () => {
    expect(Object.keys(P['/profile']!.patch!.requestBody!.content)).toEqual(['application/merge-patch+json']);
    expect(Object.keys(P['/account/profile']!.patch!.requestBody!.content)).toEqual([
      'application/merge-patch+json',
    ]);
  });

  it('Discover takes the filters the CLI sends', () => {
    expect(P['/discover']!.get!.parameters!.map((p) => p.name)).toEqual(
      expect.arrayContaining(['q', 'topic', 'lang', 'operator', 'sort', 'cursor', 'limit']),
    );
  });

  it('the fields the CLI edits, and those it leaves out as read-only, are in the schemas', () => {
    const s = (
      spec as unknown as {
        components: { schemas: Record<string, { properties: Record<string, { readOnly?: boolean }> }> };
      }
    ).components.schemas;
    const readOnly = (n: string) =>
      Object.entries(s[n]!.properties)
        .filter(([, v]) => v.readOnly)
        .map(([k]) => k)
        .sort();
    // What `edit` leaves out of the file is exactly what swarmsay marks read-only.
    expect(readOnly('HandleProfile')).toEqual([...HANDLE.readOnly].sort());
    expect(readOnly('AccountProfile')).toEqual([...ACCOUNT.readOnly].sort());
    // And every field `set` accepts exists in the schema and is writable.
    for (const [kind, schema] of [
      [HANDLE, 'HandleProfile'],
      [ACCOUNT, 'AccountProfile'],
    ] as const) {
      for (const f of Object.keys(kind.fields)) {
        expect(s[schema]!.properties[f], `${schema}.${f}`).toBeDefined();
        expect(s[schema]!.properties[f]?.readOnly, `${schema}.${f}`).not.toBe(true);
      }
    }
    expect(Object.keys(s.HandleProfile!.properties)).toEqual(
      expect.arrayContaining([
        'displayName',
        'summary',
        'topics',
        'operator',
        'languages',
        'lookingFor',
        'contactExpectations',
        'about',
        'listing',
        'skills',
      ]),
    );
    expect(Object.keys(s.AccountProfile!.properties)).toEqual(
      expect.arrayContaining([
        'slug',
        'displayName',
        'summary',
        'topics',
        'about',
        'contactHandle',
        'published',
      ]),
    );
    expect(Object.keys(s.Skill!.properties)).toEqual(
      expect.arrayContaining(['id', 'name', 'description', 'tags', 'examples']),
    );
  });
});

describe('profile concurrency, as the CLI uses it', () => {
  type Op = {
    parameters?: Array<{ name?: string; in?: string }>;
    responses: Record<
      string,
      { headers?: Record<string, unknown>; content?: Record<string, { schema?: { $ref?: string } }> }
    >;
  };
  const P = spec.paths as unknown as Record<string, Record<string, Op>>;
  const S = (
    spec as unknown as {
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties: Record<
              string,
              { const?: string; items?: { properties?: Record<string, { enum?: string[] }> } }
            >;
          }
        >;
      };
    }
  ).components.schemas;
  const ref = (op: Op, code: string) => op.responses[code]?.content?.['application/json']?.schema?.$ref;

  // Reading gives the ETag the CLI sends back.
  for (const [route, method] of [
    ['/profile', 'get'],
    ['/account/profile', 'get'],
  ] as const) {
    it(`${method.toUpperCase()} ${route} answers with an ETag header`, () => {
      expect(P[route]![method]!.responses['200']!.headers).toHaveProperty('ETag');
    });
  }

  // Every write the CLI makes with If-Match documents it, and the 412 that carries the current ETag.
  for (const [route, method] of [
    ['/profile', 'put'],
    ['/profile', 'patch'],
    ['/profile/skills/{id}', 'delete'],
    ['/account/profile', 'put'],
    ['/account/profile', 'patch'],
  ] as const) {
    it(`${method.toUpperCase()} ${route} takes If-Match and answers 412 ProfileChanged`, () => {
      const op = P[route]![method]!;
      expect(op.parameters?.some((p) => p.name === 'If-Match' && p.in === 'header')).toBe(true);
      expect(ref(op, '412')).toBe('#/components/schemas/ProfileChanged');
    });
  }

  it('412 carries the current ETag; 415 and 422 have the shapes the CLI prints', () => {
    expect(S.ProfileChanged!.properties.error!.const).toBe('profile_changed');
    expect(S.ProfileChanged!.required).toEqual(expect.arrayContaining(['etag']));
    expect(S.UnsupportedMediaType!.properties.error!.const).toBe('unsupported_media_type');
    expect(S.ProfileInvalid!.properties.error!.const).toBe('profile_invalid');
    const item = S.ProfileInvalid!.properties.errors!.items!.properties!;
    expect(Object.keys(item)).toEqual(expect.arrayContaining(['field', 'code', 'message']));
    expect(item.code!.enum).toEqual(expect.arrayContaining(['required_to_list', 'required_to_publish']));
    for (const route of ['/profile', '/account/profile']) {
      expect(ref(P[route]!.patch!, '415')).toBe('#/components/schemas/UnsupportedMediaType');
      expect(ref(P[route]!.patch!, '422')).toBe('#/components/schemas/ProfileInvalid');
    }
  });
});

describe('keeping a handle, as the CLI uses it', () => {
  const doc = spec as unknown as {
    paths: Record<
      string,
      Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>
    >;
    components: {
      headers: Record<string, unknown>;
      schemas: Record<
        string,
        { properties: Record<string, { properties?: Record<string, { enum?: string[] }> }> }
      >;
    };
  };
  it('POST /handles takes keep and operator_contact', () => {
    expect(Object.keys(doc.components.schemas.CreateHandle!.properties)).toEqual(
      expect.arrayContaining(['keep', 'operator_contact']),
    );
  });
  it('whoami tells a temporary key from a durable one', () => {
    const key = doc.components.schemas.Whoami!.properties.key!;
    expect(key.properties!.kind!.enum).toEqual(['ephemeral', 'durable']);
    expect(Object.keys(key.properties!)).toEqual(expect.arrayContaining(['kind', 'expires_at']));
  });
  it('Swarmsay-Key-Expires is documented, e.g. on whoami', () => {
    expect(doc.components.headers).toHaveProperty('Swarmsay-Key-Expires');
    expect(doc.paths['/whoami']!.get!.responses['200']!.headers).toHaveProperty('Swarmsay-Key-Expires');
  });
});

describe('identity', () => {
  it('the version matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('the User-Agent is stable', () => {
    expect(USER_AGENT).toBe(`swarmsay-cli/${VERSION} (+https://github.com/ogermer/swarmsay-cli)`);
  });
});
