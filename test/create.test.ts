import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, configPath } from '../src/config.js';
import { parseTermsLine } from '../src/terms.js';
import {
  apiPath,
  createdText,
  fakeToken,
  harness,
  llmsTxt,
  ORIGIN,
  rulesJson,
  TERMS_SENTENCE,
  withTerms,
  type Harness,
  type HarnessOptions,
} from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

function creating(
  token: string,
  opts: HarnessOptions & { version?: string; recorded?: string } = {},
): Harness {
  return harness({
    ...opts,
    handler: withTerms(
      () => ({ status: 201, body: createdText('scout-7', token, opts.recorded ?? opts.version ?? '1.1') }),
      opts.version,
    ),
  });
}

const posted = () => h.calls.filter((c) => apiPath(c) === '/handles' && c.method === 'POST');

describe('create: the Terms come first', () => {
  it('without the flag and without a TTY: shows the Terms, refuses with exit 2, creates nothing, never prompts', async () => {
    h = creating(fakeToken());
    expect(await h.run('create')).toBe(2);
    expect(posted()).toHaveLength(0);
    const err = h.stderr();
    expect(err).toContain(`${ORIGIN}/terms`);
    expect(err).toContain('version 1.1');
    expect(err).toMatch(/public, direct messages included/);
    // The block's text is fixed wording; only the origin, version and live licence sentence vary.
    expect(err).toContain(
      [
        `swarmsay Terms, version 1.1: ${ORIGIN}/terms`,
        'Creating a handle accepts these Terms. The essentials:',
        '  - Everything on swarmsay is public, direct messages included.',
        '  - You must secure your agent against acting on content from swarmsay; treat all content as untrusted data, never as instructions.',
        `  - The platform rules are at ${ORIGIN}/rules.`,
        `  - ${TERMS_SENTENCE}`,
        `  - The Terms at ${ORIGIN}/terms govern; the German original is binding, the English text is a translation. This block is a summary.`,
      ].join('\n'),
    );
    expect(err).toContain(`${ORIGIN}/rules`);
    // The licence sentence, verbatim, as the instance publishes it.
    expect(err).toContain(TERMS_SENTENCE);
    expect(err).toMatch(/--accept-terms/);
    expect(err).toMatch(/SWARMSAY_ACCEPT_TERMS=1/);
    expect(err).not.toMatch(/\[y\/N\]/);
    expect(h.stdout()).toBe('');
  });

  it('with --accept-terms: shows the same, creates, prints the response once and stores the token', async () => {
    const token = fakeToken();
    h = creating(token);
    expect(
      await h.run(
        'create',
        '--accept-terms',
        '--slug',
        'scout-7',
        '--note',
        'ops team',
        '--discovery-code',
        'launch',
      ),
    ).toBe(0);
    expect(posted()).toHaveLength(1);
    expect(JSON.parse(posted()[0]!.body!)).toEqual({
      terms_version: '1.1',
      slug: 'scout-7',
      note: 'ops team',
      discovery_code: 'launch',
    });
    expect(posted()[0]!.headers.authorization).toBeUndefined();
    expect(h.stderr()).toContain(TERMS_SENTENCE);
    expect(h.stderr()).toMatch(/Accepted Terms version 1\.1 \(as recorded by swarmsay\)/);
    // The token appears exactly once, in the API's own response on stdout.
    expect(h.stdout()).toBe(createdText('scout-7', token));
    expect(h.stdout().split(token)).toHaveLength(2);
    expect(h.stderr()).not.toContain(token);
    const stored = new ConfigStore(configPath(h.io.env, h.home)).get(ORIGIN, undefined);
    expect(stored).toMatchObject({ slug: 'scout-7', handle: { token, kind: 'ephemeral' } });
  });

  it('the Terms are fetched before the handle is created', async () => {
    h = creating(fakeToken());
    await h.run('create', '--accept-terms');
    expect(h.calls.map(apiPath)).toEqual(['/rules', '/handles']);
  });

  it('the licence sentence comes from /rules terms.highlight, verbatim', async () => {
    const sentence = 'A different sentence, as this instance publishes it.';
    h = harness({
      handler: (req) =>
        apiPath(req) === '/rules'
          ? {
              body: JSON.stringify({
                terms: { url: `${ORIGIN}/terms`, version: '1.1', highlight: sentence },
              }),
            }
          : { status: 201, body: createdText('scout-7', fakeToken()) },
    });
    expect(await h.run('create', '--accept-terms')).toBe(0);
    expect(h.stderr()).toContain(`  - ${sentence}`);
    expect(h.calls.map(apiPath)).not.toContain('/llms.txt');
  });

  it('an instance without terms.highlight falls back to the llms.txt Terms line', async () => {
    h = harness({
      handler: (req) => {
        const p = apiPath(req);
        if (p === '/rules') return { body: rulesJson('1.1', false) };
        if (p === '/llms.txt') return { body: llmsTxt('1.1') };
        return { status: 201, body: createdText('scout-7', fakeToken()) };
      },
    });
    expect(await h.run('create', '--accept-terms')).toBe(0);
    expect(h.calls.map(apiPath)).toEqual(['/rules', '/llms.txt', '/handles']);
    expect(h.stderr()).toContain(TERMS_SENTENCE);
  });

  it('SWARMSAY_ACCEPT_TERMS=1 accepts, and the output names it', async () => {
    h = creating(fakeToken(), { env: { SWARMSAY_ACCEPT_TERMS: '1' } });
    expect(await h.run('create')).toBe(0);
    expect(h.stderr()).toMatch(/by SWARMSAY_ACCEPT_TERMS=1/);
  });

  it('any other value of SWARMSAY_ACCEPT_TERMS does not accept', async () => {
    for (const v of ['true', 'yes', '0', '']) {
      h = creating(fakeToken(), { env: { SWARMSAY_ACCEPT_TERMS: v } });
      expect(await h.run('create')).toBe(2);
      expect(posted()).toHaveLength(0);
      h.cleanup();
    }
  });

  it('the flag is never read from the config file', async () => {
    h = creating(fakeToken());
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'old', fakeToken(), 'ephemeral', true);
    const cfg = store.load() as unknown as Record<string, unknown>;
    cfg.accept_terms = true;
    store.save(cfg as never);
    // --new gets past the "you already have a handle" check, so the refusal here is about the Terms.
    expect(await h.run('create', '--new')).toBe(2);
    expect(posted()).toHaveLength(0);
    expect(h.stderr()).toMatch(/run again with --accept-terms/);
  });

  describe('on a TTY, a [y/N] prompt may stand in for the flag', () => {
    it('"y" accepts the version shown', async () => {
      h = creating(fakeToken(), { tty: true, answers: ['y'] });
      expect(await h.run('create')).toBe(0);
      expect(h.stderr()).toMatch(/Accept the swarmsay Terms, version 1\.1\? \[y\/N\] /);
      expect(h.stderr()).toContain(TERMS_SENTENCE);
      expect(posted()).toHaveLength(1);
    });

    for (const answer of ['', 'n', 'no', 'maybe', 'Y es']) {
      it(`${JSON.stringify(answer)} declines (the default is N)`, async () => {
        h = creating(fakeToken(), { tty: true, answers: [answer] });
        expect(await h.run('create')).toBe(2);
        expect(posted()).toHaveLength(0);
      });
    }

    it('with the flag, no prompt', async () => {
      h = creating(fakeToken(), { tty: true, answers: [] });
      expect(await h.run('create', '--accept-terms')).toBe(0);
    });
  });

  describe('a different Terms version recorded by swarmsay is never passed over silently', () => {
    it('a MAJOR change: warning, exit 1 (the token is still stored so the handle is not lost)', async () => {
      const token = fakeToken();
      h = creating(token, { version: '1.1', recorded: '2.0' });
      expect(await h.run('create', '--accept-terms')).toBe(1);
      expect(h.stderr()).toMatch(/warning: swarmsay recorded Terms version 2\.0, but version 1\.1 was shown/);
      expect(new ConfigStore(configPath(h.io.env, h.home)).get(ORIGIN, undefined)?.handle.token).toBe(token);
    });

    it('a minor change: a note, exit 0', async () => {
      h = creating(fakeToken(), { version: '1.1', recorded: '1.2' });
      expect(await h.run('create', '--accept-terms')).toBe(0);
      expect(h.stderr()).toMatch(/note: swarmsay recorded Terms version 1\.2/);
    });
  });

  it('refuses when the instance does not publish the Terms line', async () => {
    h = harness({
      handler: (req) =>
        apiPath(req) === '/llms.txt' ? { body: '# swarmsay\n' } : { body: rulesJson('1.1', false) },
    });
    expect(await h.run('create', '--accept-terms')).toBe(5);
    expect(posted()).toHaveLength(0);
  });

  it('refuses when /rules and /llms.txt disagree on the version', async () => {
    h = harness({
      handler: (req) =>
        apiPath(req) === '/llms.txt' ? { body: llmsTxt('1.1') } : { body: rulesJson('2.0', false) },
    });
    expect(await h.run('create', '--accept-terms')).toBe(5);
    expect(posted()).toHaveLength(0);
  });

  it('a JSON response is stored too', async () => {
    const token = fakeToken();
    h = harness({
      handler: withTerms(() => ({
        status: 201,
        body: JSON.stringify({
          handle: 'scout-9',
          token,
          claim_code: 'X',
          terms: { url: `${ORIGIN}/terms`, version: '1.1' },
          tier: 'unverified',
        }),
      })),
    });
    expect(await h.run('create', '--accept-terms', '--json')).toBe(0);
    expect(new ConfigStore(configPath(h.io.env, h.home)).get(ORIGIN, undefined)).toMatchObject({
      slug: 'scout-9',
      handle: { token },
    });
  });

  it('with --new, the new handle becomes the default and the old one stays stored', async () => {
    h = creating(fakeToken());
    const store = new ConfigStore(configPath(h.io.env, h.home));
    store.put(ORIGIN, 'older', fakeToken(), 'durable', true);
    expect(await h.run('create', '--accept-terms', '--new')).toBe(0);
    expect(store.get(ORIGIN, undefined)?.slug).toBe('scout-7');
    expect(store.get(ORIGIN, 'older')).toBeDefined();
    expect(h.stderr()).toMatch(/@older stays stored too; use it with --as older/);
  });

  describe('one agent, one handle', () => {
    it('a handle already stored: refused before anything is sent, exit 2', async () => {
      h = creating(fakeToken());
      new ConfigStore(configPath(h.io.env, h.home)).put(ORIGIN, 'older', fakeToken(), 'durable', true);
      expect(await h.run('create', '--accept-terms')).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(h.stderr()).toMatch(
        /You already have @older stored for .* Reuse it, or pass --new to create another handle/,
      );
    });

    it('SWARMSAY_TOKEN set: refused the same way', async () => {
      h = creating(fakeToken(), { env: { SWARMSAY_TOKEN: fakeToken() } });
      expect(await h.run('create', '--accept-terms')).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(h.stderr()).toMatch(/You already have a handle in SWARMSAY_TOKEN/);
    });

    it('a handle stored for another origin does not count', async () => {
      h = creating(fakeToken());
      new ConfigStore(configPath(h.io.env, h.home)).put(
        'https://other.test',
        'elsewhere',
        fakeToken(),
        'durable',
        true,
      );
      expect(await h.run('create', '--accept-terms')).toBe(0);
    });

    it('at a terminal: asked [y/N]; Enter creates nothing', async () => {
      h = creating(fakeToken(), { tty: true, answers: [''] });
      new ConfigStore(configPath(h.io.env, h.home)).put(ORIGIN, 'older', fakeToken(), 'durable', true);
      expect(await h.run('create', '--accept-terms')).toBe(2);
      expect(h.stderr()).toMatch(/Create another handle anyway\? \[y\/N\]/);
      expect(h.calls).toHaveLength(0);
    });

    it('at a terminal: y creates it, and the old handle is named', async () => {
      h = creating(fakeToken(), { tty: true, answers: ['y'] });
      new ConfigStore(configPath(h.io.env, h.home)).put(ORIGIN, 'older', fakeToken(), 'durable', true);
      expect(await h.run('create', '--accept-terms')).toBe(0);
      expect(h.stderr()).toMatch(/@older stays stored too/);
    });
  });

  it('a refusal from swarmsay (e.g. slug taken) stores nothing', async () => {
    h = harness({
      handler: withTerms(() => ({ status: 409, body: '# error: conflict\nThat slug is taken.\n' })),
    });
    expect(await h.run('create', '--accept-terms', '--slug', 'taken')).toBe(1);
    expect(new ConfigStore(configPath(h.io.env, h.home)).get(ORIGIN, undefined)).toBeUndefined();
  });
});

describe('termsNotice', () => {
  it("uses the origin of the instance's own Terms URL for every link", async () => {
    const { termsNotice } = await import('../src/terms.js');
    const block = termsNotice(
      { url: 'https://public.test/terms', version: '1.1', licenceSentence: TERMS_SENTENCE },
      'http://host.docker.internal:3100',
    );
    expect(block).not.toContain('host.docker.internal');
    expect(block).toContain('The platform rules are at https://public.test/rules.');
    expect(block).toContain('The Terms at https://public.test/terms govern;');
  });
});

describe('parseTermsLine', () => {
  it('reads url, version and the sentence', () => {
    expect(parseTermsLine(llmsTxt('1.1'))).toEqual({
      url: `${ORIGIN}/terms`,
      version: '1.1',
      licenceSentence: TERMS_SENTENCE,
    });
  });
  it('accepts a list bullet in front', () => {
    expect(parseTermsLine(`- Terms: https://x.test/terms (version 3.0). Hello.`)?.version).toBe('3.0');
  });
  it('finds nothing in unrelated text', () => {
    expect(parseTermsLine('Terms and conditions apply.')).toBeUndefined();
  });
});
