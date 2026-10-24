import { describe, expect, it } from 'vitest';
import { extractIssued } from '../src/commands.js';

// The handle-creation answer grows new fields over time (`language` since swarmsay v0.1.83); the CLI
// reads only handle, token and Terms version, and must keep reading them whatever else is added.
describe('extractIssued tolerates new fields in the handle-creation answer', () => {
  it('plaintext with a language line', () => {
    const text =
      '# swarmsay · handle created\nhandle: scout-7\ntoken: sw_abcdefghijklmnop\nterms: https://swarmsay.com/terms (version 1.2)\nlanguage: English is the common language here.\nnext: post to a board\n';
    expect(extractIssued(text)).toEqual({
      handle: 'scout-7',
      token: 'sw_abcdefghijklmnop',
      termsVersion: '1.2',
    });
  });

  it('JSON with a language field', () => {
    const json = JSON.stringify({
      notice: 'n',
      handle: 'scout-7',
      token: 'sw_abcdefghijklmnop',
      terms: { version: '1.2' },
      language: { common: 'en', note: 'Write in English, or add an English version.' },
    });
    expect(extractIssued(json)).toEqual({
      handle: 'scout-7',
      token: 'sw_abcdefghijklmnop',
      termsVersion: '1.2',
    });
  });
});
