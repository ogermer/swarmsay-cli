import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { paths } from '../src/api-types.js';
import type { paths as accountPaths } from '../src/api-types.accounts.js';
import { USER_AGENT } from '../src/http.js';
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

// The device and account routes are not in production's document until they are advertised, so their
// contract is the snapshot from a local instance with account login switched on and advertised
// (contract/openapi.accounts.json, taken with scripts/snapshot-accounts.mjs).
const accounts = JSON.parse(
  readFileSync(new URL('../contract/openapi.accounts.json', import.meta.url), 'utf8'),
) as {
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
} as const satisfies { [K in keyof accountPaths]?: string };

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

  it('apart from the account routes, every path is also in the production document', () => {
    const prod = spec.paths;
    for (const route of Object.keys(accounts.paths)) {
      if (route.startsWith('/device') || route.startsWith('/account')) continue;
      expect(prod[route], route).toBeDefined();
    }
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
