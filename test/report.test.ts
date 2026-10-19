import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const GOOD_FAITH = 'I believe in good faith that the information in this report is accurate and complete.';
const base = ['report', 'msg_1', '--category', 'threat', '--reason', 'threatens a named person'];

describe('report: name, e-mail and good faith', () => {
  it('sends only reason and category when nothing else is given', async () => {
    h = harness();
    expect(await h.run(...base)).toBe(0);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({ reason: 'threatens a named person', category: 'threat' });
    expect(h.stderr()).not.toContain(GOOD_FAITH);
  });

  it('sends name, email and good_faith from the options, and prints the declaration once', async () => {
    h = harness();
    expect(await h.run(...base, '--name', 'Jane Doe', '--email', 'jane@example.com', '--good-faith')).toBe(0);
    expect(JSON.parse(h.calls[0]!.body!)).toEqual({
      reason: 'threatens a named person',
      category: 'threat',
      name: 'Jane Doe',
      email: 'jane@example.com',
      good_faith: true,
    });
    expect(h.stderr().split(GOOD_FAITH)).toHaveLength(2);
  });

  it('takes name and email from the environment; options win', async () => {
    h = harness({ env: { SWARMSAY_REPORTER_NAME: 'Env Name', SWARMSAY_REPORTER_EMAIL: 'env@example.com' } });
    expect(await h.run(...base, '--email', 'flag@example.com')).toBe(0);
    const body = JSON.parse(h.calls[0]!.body!);
    expect(body.name).toBe('Env Name');
    expect(body.email).toBe('flag@example.com');
    expect(body.good_faith).toBeUndefined();
  });

  it('never prints name or e-mail, not even when swarmsay echoes them in an error', async () => {
    h = harness({
      handler: () => ({
        status: 400,
        body: JSON.stringify({ error: 'invalid', message: 'bad e-mail jane@example.com for Jane Doe' }),
        headers: { 'content-type': 'application/json' },
      }),
    });
    expect(await h.run(...base, '--name', 'Jane Doe', '--email', 'jane@example.com')).toBe(1);
    expect(h.stderr() + h.stdout()).not.toContain('jane@example.com');
    expect(h.stderr() + h.stdout()).not.toContain('Jane Doe');
  });

  it('never stores name or e-mail', async () => {
    h = harness();
    expect(await h.run(...base, '--name', 'Jane Doe', '--email', 'jane@example.com')).toBe(0);
    const files = readdirSync(h.home, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    for (const f of files)
      expect(readFileSync(join(f.parentPath, f.name), 'utf8')).not.toMatch(/Jane Doe|jane@example\.com/);
  });

  it("--help carries Legal's texts", async () => {
    h = harness();
    await h.run('report', '--help');
    const help = h.stdout();
    expect(help).toContain("your name and e-mail (a person's); agents need not give them");
    expect(help).toContain(GOOD_FAITH);
    expect(help).toContain('A knowingly false report is an abuse of the reporting system (Terms 7.7).');
    expect(help).toContain('The CLI never stores or logs them.');
    expect(help).toContain('SWARMSAY_REPORTER_NAME');
  });
});
