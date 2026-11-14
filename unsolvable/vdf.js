'use strict';
/**
 * vdf.js — Wesolowski VDF (RSA-2048) for UNSOLVABLE.
 *
 *   y = x^(2^T) mod N            (T sequential squarings)
 *   l = hashToPrime(x, y, T):    s = sha256(utf8("unsolvable-vdf|" + hex(x)
 *                                  + "|" + hex(y) + "|" + T))
 *                                hex() = lowercase, no 0x, no leading zeros
 *                                first 16 bytes as big-endian int, set bit 127
 *                                and bit 0, add 2 until prime (Miller-Rabin)
 *   proof = x^floor(2^T / l) mod N
 *   verify: proof^l * x^(2^T mod l) == y (mod N)
 *
 * Proof is computed with the incremental quotient-tracking recurrence, so it
 * costs ~1 extra squaring per step instead of a second full exponentiation:
 *   r_i = 2^i mod l,  pi_i = x^floor(2^i / l) mod N
 *   2*r_i = b*l + r_{i+1}  (b in {0,1}),  pi_{i+1} = pi_i^2 * x^b mod N
 * NOTE: l depends on y_T, so the squaring loop runs first to get y (and l),
 * then a second cheap loop runs only the pi recurrence (one squaring/step,
 * no y recomputation, no million-bit exponent).
 *
 * If the GMP helper binary ./vdf-gmp exists, both loops run in GMP (~3x
 * faster); otherwise plain BigInt is used. Fallback is automatic.
 *
 * Exports: computeVdf(xHex, t, nHex) -> { y: '0x...', proof: '0x...' }
 *          verifyVdf(xHex, yHex, proofHex, t, nHex) -> boolean
 *          hashToPrime(x, y, T) -> BigInt  (x, y BigInt; T number)
 *          backend() -> 'gmp' | 'bigint'
 * No npm dependencies, CommonJS.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GMP_BIN = path.join(__dirname, 'vdf-gmp');
let gmpState = null; // null = untested, true/false = usable or not
let gmpBroken = false;

function gmpAvailable() {
  if (gmpBroken) return false;
  if (gmpState !== null) return gmpState;
  try {
    gmpState = fs.existsSync(GMP_BIN) && fs.statSync(GMP_BIN).isFile();
    if (gmpState) {
      // smoke test: square loop, T=2, N=35, x=2 -> 2^(4) = 16 mod 35
      const r = spawnSync(GMP_BIN, ['square', '2', '23', '2'], { encoding: 'utf8', timeout: 5000 });
      gmpState = r.status === 0 && r.stdout.trim() === '10';
    }
  } catch (_) {
    gmpState = false;
  }
  return gmpState;
}

function backend() {
  return gmpAvailable() ? 'gmp' : 'bigint';
}

function runGmp(args) {
  const r = spawnSync(GMP_BIN, args, { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('vdf-gmp exited ' + r.status + ': ' + (r.stderr || ''));
  const out = (r.stdout || '').trim();
  if (!/^[0-9a-f]+$/.test(out)) throw new Error('vdf-gmp bad output: ' + out);
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseHex(h) {
  if (typeof h !== 'string') throw new TypeError('hex string expected');
  let s = h.toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (s === '') return 0n;
  return BigInt('0x' + s);
}

function toHex(b) {
  return '0x' + b.toString(16);
}

function hexNoPrefix(b) {
  return b.toString(16); // lowercase, no leading zeros ('0' for zero)
}

function modPow(base, exp, mod) {
  if (mod === 1n) return 0n;
  let b = base % mod;
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    e >>= 1n;
    if (e > 0n) b = (b * b) % mod;
  }
  return r;
}

// Miller-Rabin (deterministic enough for 128-bit candidates: trial division
// by small primes + the first 16 prime bases; error prob. astronomically low).
const SMALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97];
const MR_BASES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];

function isPrime(n) {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    const bp = BigInt(p);
    if (n === bp) return true;
    if (n % bp === 0n) return false;
  }
  // write n-1 = d * 2^s
  let d = n - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  for (const a of MR_BASES) {
    const ab = BigInt(a);
    if (ab >= n - 1n) continue;
    let x = modPow(ab, d, n);
    if (x === 1n || x === n - 1n) continue;
    let cont = false;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) { cont = true; break; }
    }
    if (!cont) return false;
  }
  return true;
}

function hashToPrime(x, y, T) {
  const s = 'unsolvable-vdf|' + hexNoPrefix(x) + '|' + hexNoPrefix(y) + '|' + String(T);
  const digest = crypto.createHash('sha256').update(s, 'utf8').digest();
  let cand = BigInt('0x' + digest.subarray(0, 16).toString('hex'));
  cand |= (1n << 127n); // set bit 127
  cand |= 1n;            // set bit 0 (odd)
  while (!isPrime(cand)) cand += 2n;
  return cand;
}

// ---------------------------------------------------------------------------
// BigInt implementation
// ---------------------------------------------------------------------------
function squareLoopBigInt(x, T, N) {
  let y = x % N;
  for (let i = 0; i < T; i++) y = (y * y) % N;
  return y;
}

function proofLoopBigInt(x, T, N, l) {
  // pi_i = x^floor(2^i / l), r_i = 2^i mod l; see header for recurrence.
  let pi = 1n;
  let r = 1n % l;
  for (let i = 0; i < T; i++) {
    const twoR = r * 2n;
    const b = twoR >= l;
    r = b ? twoR - l : twoR;
    pi = (pi * pi) % N;
    if (b) pi = (pi * x) % N;
  }
  return pi;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
function computeVdf(xHex, t, nHex) {
  const T = typeof t === 'bigint' ? Number(t) : t;
  if (!Number.isInteger(T) || T < 0) throw new TypeError('t must be a non-negative integer');
  const N = parseHex(nHex);
  let x = parseHex(xHex) % N;

  if (gmpAvailable()) {
    try {
      const yHex = runGmp(['square', hexNoPrefix(x), hexNoPrefix(N), String(T)]);
      const y = parseHex(yHex);
      const l = hashToPrime(x, y, T);
      const proofHex = runGmp(['proof', hexNoPrefix(x), hexNoPrefix(N), String(T), hexNoPrefix(l)]);
      return { y: toHex(y), proof: '0x' + proofHex };
    } catch (e) {
      // fall through to the BigInt path; don't retry GMP this process
      gmpBroken = true;
    }
  }

  const y = squareLoopBigInt(x, T, N);
  const l = hashToPrime(x, y, T);
  const proof = proofLoopBigInt(x, T, N, l);
  return { y: toHex(y), proof: toHex(proof) };
}

function verifyVdf(xHex, yHex, proofHex, t, nHex) {
  const T = typeof t === 'bigint' ? Number(t) : t;
  if (!Number.isInteger(T) || T < 0) return false;
  let x, y, proof, N;
  try {
    N = parseHex(nHex);
    x = parseHex(xHex) % N;
    y = parseHex(yHex) % N;
    proof = parseHex(proofHex) % N;
  } catch (_) {
    return false;
  }
  if (N <= 1n) return false;
  const l = hashToPrime(x, y, T);
  const r = modPow(2n, BigInt(T), l); // 2^T mod l
  const lhs = (modPow(proof, l, N) * modPow(x, r, N)) % N;
  return lhs === y;
}

module.exports = { computeVdf, verifyVdf, hashToPrime, isPrime, modPow, backend };
