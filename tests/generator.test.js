import { describe, it, expect } from 'vitest';
import { generatePassword, generatePassphrase, randomInt, estimateBits, strengthLabel } from '../src/generator.js';
import { WORDS } from '../src/wordlist.js';

describe('generator', () => {
  it('honours length and character classes', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 16, lower: true, upper: true, digits: true, symbols: true });
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^a-zA-Z0-9]/);
    }
    expect(generatePassword({ length: 30, symbols: false, digits: false, upper: false })).toMatch(/^[a-z]{30}$/);
  });
  it('passphrase uses wordlist words', () => {
    const p = generatePassphrase({ words: 6, separator: ' ' }).split(' ');
    expect(p).toHaveLength(6);
    p.forEach((w) => expect(WORDS).toContain(w));
    expect(WORDS).toHaveLength(7776);
  });
  it('randomInt is in range and roughly uniform', () => {
    const n = 7, counts = Array(n).fill(0);
    for (let i = 0; i < 7000; i++) counts[randomInt(n)]++;
    counts.forEach((c) => expect(c).toBeGreaterThan(800));
  });
  it('strength estimate orders sensibly', () => {
    expect(strengthLabel(estimateBits('password1')).level).toBe(0);
    expect(strengthLabel(estimateBits('Tr0ub4dor&3')).level).toBeLessThanOrEqual(2);
    expect(strengthLabel(estimateBits(generatePassword({ length: 20 }))).level).toBe(3);
    expect(strengthLabel(estimateBits(generatePassphrase({ words: 5 }))).level).toBeGreaterThanOrEqual(1);
    expect(strengthLabel(estimateBits(generatePassphrase({ words: 6 }))).level).toBeGreaterThanOrEqual(2);
    expect(estimateBits('correcthorsebatterystaple')).toBeLessThan(70);
    expect(estimateBits('my-dog-rex')).toBeLessThan(40);
  });
});
