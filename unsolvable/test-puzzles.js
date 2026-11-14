'use strict';
/**
 * test-puzzles.js — CLI test for the UNSOLVABLE solvers.
 *
 *  (a) 3 planted coloring instances (n=1000, avg degree 5.6), solve + verify.
 *  (b) 3 planted subset instances (n=36, numbers < 2^60), solve + verify sums.
 *  (c) VDF correctness on a 512-bit modulus, T=1000: verifyVdf AND the
 *      independent server equation proof^l * x^(2^T mod l) == y (mod N).
 *  (d) VDF timing: T=4,000,000 on a random 2048-bit modulus.
 *
 * Budgets: coloring 60s each, subset 10s each, VDF 3 min.
 * Exit 0 only if everything passes within budget; exit 1 otherwise.
 * No network, no npm dependencies. Usage: node test-puzzles.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { solveColoring } = require('./coloring.js');
const { solveSubset } = require('./subset.js');
const vdf = require('./vdf.js');
const { computeVdf, verifyVdf, hashToPrime, modPow } = vdf;

const BUDGET_COLORING_MS = 60_000;
const BUDGET_SUBSET_MS = 10_000;
const BUDGET_VDF_MS = 180_000;

let failures = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function nowMs() { return Date.now(); }
function randBig(bits) {
  const bytes = Math.ceil(bits / 8);
  let v = BigInt('0x' + crypto.randomBytes(bytes).toString('hex'));
  return v & ((1n << BigInt(bits)) - 1n);
}
function randModulus(bits) {
  let n = randBig(bits);
  n |= (1n << BigInt(bits - 1)); // top bit set -> full bit-length
  n |= 1n;                        // odd
  return n;
}

// ---------------------------------------------------------------------------
// (a) coloring
// ---------------------------------------------------------------------------
function genColoring(n, avgDeg) {
  const planted = Array.from({ length: n }, () => (Math.random() * 3) | 0);
  const seen = new Set();
  const edges = [];
  const m = Math.round((n * avgDeg) / 2);
  let guard = 0;
  while (edges.length < m && guard++ < m * 100) {
    const u = (Math.random() * n) | 0;
    const v = (Math.random() * n) | 0;
    if (u === v || planted[u] === planted[v]) continue;
    const k = u < v ? u * n + v : v * n + u;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push([u, v]);
  }
  return { edges, planted };
}

function verifyColoring(n, edges, s) {
  if (typeof s !== 'string' || s.length !== n) return 'bad length/type';
  for (let i = 0; i < n; i++) if (s[i] !== '0' && s[i] !== '1' && s[i] !== '2') return 'bad char at ' + i;
  for (const [u, v] of edges) if (s[u] === s[v]) return `edge ${u}-${v} monochromatic`;
  return null;
}

console.log('=== (a) coloring: 3 planted instances, n=1000, avg degree 5.6 ===');
for (let i = 0; i < 3; i++) {
  const { edges } = genColoring(1000, 5.6);
  const t0 = nowMs();
  const sol = solveColoring(1000, edges);
  const dt = nowMs() - t0;
  const err = sol ? verifyColoring(1000, edges, sol) : 'returned null';
  check(`coloring #${i + 1} (${edges.length} edges)`, !err && dt <= BUDGET_COLORING_MS,
    `${(dt / 1000).toFixed(2)}s${err ? ' — ' + err : ''}`);
}

// ---------------------------------------------------------------------------
// (b) subset-sum
// ---------------------------------------------------------------------------
function genSubset(n, bits) {
  const numbers = [];
  for (let i = 0; i < n; i++) numbers.push((randBig(bits) | 1n).toString());
  // planted solution: random ~half of the numbers
  const chosen = new Set();
  for (let i = 0; i < n; i++) if (Math.random() < 0.5) chosen.add(i);
  if (chosen.size === 0) chosen.add((Math.random() * n) | 0);
  const target = [...chosen].reduce((s, i) => s + BigInt(numbers[i]), 0n).toString();
  return { numbers, target };
}

console.log('=== (b) subset-sum: 3 planted instances, n=36, numbers < 2^60 ===');
for (let i = 0; i < 3; i++) {
  const { numbers, target } = genSubset(36, 60);
  const t0 = nowMs();
  const sol = solveSubset(numbers, target);
  const dt = nowMs() - t0;
  let err = null;
  if (!sol) err = 'returned null';
  else if (sol.length !== 36 || /[^01]/.test(sol)) err = 'bad solution string';
  else {
    const sum = [...sol].reduce((s, c, j) => s + (c === '1' ? BigInt(numbers[j]) : 0n), 0n);
    if (sum !== BigInt(target)) err = `sum mismatch: got ${sum}, want ${target}`;
  }
  check(`subset #${i + 1}`, !err && dt <= BUDGET_SUBSET_MS,
    `${(dt / 1000).toFixed(2)}s${err ? ' — ' + err : ''}`);
}

// ---------------------------------------------------------------------------
// (c) VDF correctness, 512-bit modulus, T=1000
// ---------------------------------------------------------------------------
console.log('=== (c) VDF correctness: 512-bit modulus, T=1000 ===');
{
  const N = randModulus(512);
  let x = randBig(512) % N;
  if (x < 2n) x = 2n;
  const T = 1000;
  const t0 = nowMs();
  const { y, proof } = computeVdf('0x' + x.toString(16), T, '0x' + N.toString(16));
  const dt = nowMs() - t0;
  const okVerify = verifyVdf('0x' + x.toString(16), y, proof, T, '0x' + N.toString(16));
  check('VDF verifyVdf', okVerify, `${(dt / 1000).toFixed(2)}s, backend=${vdf.backend()}`);

  // Independent check of the server equation, computed directly here:
  //   proof^l * x^(2^T mod l) == y (mod N), with l = hashToPrime(x, y, T)
  const yB = BigInt(y), pB = BigInt(proof);
  const l = hashToPrime(x, yB, T);
  const r = modPow(2n, BigInt(T), l);
  const lhs = (modPow(pB, l, N) * modPow(x, r, N)) % N;
  check('VDF independent server equation', lhs === yB, `l is ${l.toString(16).slice(0, 12)}... (${l.toString(2).length} bits)`);

  // Negative control: tampered proof must fail verification.
  const badProof = '0x' + ((pB + 1n) % N).toString(16);
  const okBad = verifyVdf('0x' + x.toString(16), y, badProof, T, '0x' + N.toString(16));
  check('VDF tampered proof rejected', okBad === false);

  // Direct y check: y == x^(2^T) mod N via repeated squaring (independent loop).
  let yy = x;
  for (let i = 0; i < T; i++) yy = (yy * yy) % N;
  check('VDF y == x^(2^T) mod N', yy === yB);
}

// ---------------------------------------------------------------------------
// (d) VDF timing, 2048-bit modulus, T=4,000,000
// ---------------------------------------------------------------------------
console.log('=== (d) VDF timing: 2048-bit modulus, T=4,000,000 ===');
{
  const N = randModulus(2048);
  let x = randBig(2048) % N;
  if (x < 2n) x = 2n;
  const T = 4_000_000;
  console.log(`backend: ${vdf.backend()} (gmp binary ${fs.existsSync(path.join(__dirname, 'vdf-gmp')) ? 'present' : 'absent'})`);
  const t0 = nowMs();
  const { y, proof } = computeVdf('0x' + x.toString(16), T, '0x' + N.toString(16));
  const dt = nowMs() - t0;
  console.log(`computeVdf T=${T}: ${(dt / 1000).toFixed(1)}s`);
  const okVerify = verifyVdf('0x' + x.toString(16), y, proof, T, '0x' + N.toString(16));
  check(`VDF T=4M, 2048-bit (backend=${vdf.backend()})`, okVerify && dt <= BUDGET_VDF_MS,
    `${(dt / 1000).toFixed(1)}s, verify=${okVerify}`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
