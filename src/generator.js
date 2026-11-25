// Password / passphrase generator. All randomness from crypto.getRandomValues with rejection
// sampling (no modulo bias). Never Math.random.
import { WORDS } from './wordlist.js';

export function randomInt(max) {
  if (!(max > 0 && max <= 0x100000000)) throw new RangeError('max out of range');
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz', // no l
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', // no I, O
  digits: '23456789', // no 0, 1
  symbols: '!@#$%^&*-_=+?',
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
  const pools = [];
  if (lower) pools.push(SETS.lower);
  if (upper) pools.push(SETS.upper);
  if (digits) pools.push(SETS.digits);
  if (symbols) pools.push(SETS.symbols);
  if (!pools.length) pools.push(SETS.lower);
  length = Math.max(length, pools.length);
  const all = pools.join('');
  // Guarantee at least one char from each chosen class, fill the rest from the union, shuffle.
  const out = pools.map((p) => p[randomInt(p.length)]);
  while (out.length < length) out.push(all[randomInt(all.length)]);
  return shuffle(out).join('');
}

export function generatePassphrase({ words = 5, separator = '-', capitalize = false, number = false } = {}) {
  const picked = Array.from({ length: Math.max(words, 3) }, () => {
    const w = WORDS[randomInt(WORDS.length)];
    return capitalize ? w[0].toUpperCase() + w.slice(1) : w;
  });
  if (number) {
    const i = randomInt(picked.length);
    picked[i] += String(randomInt(10));
  }
  return picked.join(separator);
}

/** Rough strength estimate in bits for display only. Penalises repeats, runs and common words. */
export function estimateBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(pool || 1);
  // repeated characters and simple sequences add little
  const uniq = new Set(pw).size;
  bits *= Math.min(1, (uniq + pw.length) / (2 * pw.length) + 0.15);
  if (/(.)\1{2,}/.test(pw)) bits -= 8;
  if (/(?:abc|bcd|cde|def|123|234|345|456|567|678|789|qwe|wer|asd|sdf|zxc)/i.test(pw)) bits -= 10;
  if (/^(?:password|letmein|welcome|admin|qwerty|iloveyou|monkey|dragon)/i.test(pw)) bits -= 25;
  if (/^[A-Za-z]+[0-9!@#$%^&*]{1,3}$/.test(pw)) bits -= 8; // Word + digits pattern
  // Passphrases: the character-pool estimate wildly overrates words joined by separators, so score
  // them per word instead (~11.5 bits each: conservative vs. 12.9 for a random EFF-list word).
  const tokens = pw.split(/[\s\-_.]+/).filter(Boolean);
  if (tokens.length >= 3 && tokens.every((w) => /^[a-zA-Z]{2,10}\d?$/.test(w))) {
    bits = tokens.length * 11.5;
  } else if (/^[a-zA-Z]+$/.test(pw)) {
    bits = Math.min(bits, pw.length * 2.6); // letters only: assume natural-language-ish text
  }
  return Math.max(0, bits);
}

export function strengthLabel(bits) {
  if (bits < 40) return { label: 'Weak', level: 0 };
  if (bits < 60) return { label: 'Fair', level: 1 };
  if (bits < 80) return { label: 'Good', level: 2 };
  return { label: 'Strong', level: 3 };
}
