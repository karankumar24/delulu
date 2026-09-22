// Keys and addresses are hidden before anything is shortened, so a cut can never leave part of one.
import { describe, it, expect } from 'vitest';
import { makeRedactor, clipText } from './redact';

describe('redact', () => {
  const redact = makeRedactor({ ownEmail: 'me@college.edu', typedEmails: ['friend@uni.edu'] });

  it('hides keys and tokens of every listed shape', () => {
    for (const key of ['sk-ant-api03-abcdefghijklmnopqrstuv', 'sb_secret_abcdefghijklmnopqrstuvwx', 'ya29.a0AfH6SMBabcdefghijklmnop',
      'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX'])
      expect(redact(`key ${key} here`)).toBe('key [redacted-secret] here');
    expect(redact('set DB_PASSWORD=correcthorsebatterystaple then')).toBe('set [redacted-secret] then');
  });

  it('leaves request ids, deployment ids and counts alone', () => {
    expect(redact('password: required, and SECRET_SANTA is a game')).toBe('password: required, and SECRET_SANTA is a game');
    const text = 'req_011CeuHSuzZT2dtPvfLfHfow and dpl_3HQkswdMBgEmRoUzb7JGAGq2rMWk, tokens = 28,000';
    expect(redact(text)).toBe(text);
  });

  it("keeps the user's own address and ones they typed, and hides the rest", () => {
    expect(redact('me@college.edu, friend@uni.edu, stranger@corp.com')).toBe('me@college.edu, friend@uni.edu, [redacted-email]');
  });

  it('never leaks part of a key when a line is shortened', () => {
    const out = clipText(`${'x'.repeat(290)} sk-ant-api03-abcdefghijklmnopqrstuvwxyz`, 300, redact);
    expect(out).not.toMatch(/sk-ant/);
    expect(out.endsWith('…')).toBe(true);
  });
});
