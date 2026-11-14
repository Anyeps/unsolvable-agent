'use strict';
/**
 * test-sat.js — CLI test for sat.js.
 *
 * Generates 5 fresh instances of n=1024, ratio 5.2 (UNSOVABLE tier 1),
 * solves each with solveSat(), verifies every clause against the returned
 * assignment, and prints per-instance time + total + pass/fail.
 * Exits 0 only if all 5 solve correctly within 2 minutes each.
 *
 * Usage: node test-sat.js [n=1024] [ratio=5.2] [count=5] [timeLimitMs=120000]
 */
const { genSat } = require('./gen-sat');
const { solveSat, checkAssignment } = require('./sat');

async function main() {
  const n = parseInt(process.argv[2] || '1024', 10);
  const ratio = parseFloat(process.argv[3] || '5.2');
  const count = parseInt(process.argv[4] || '5', 10);
  const timeLimitMs = parseInt(process.argv[5] || '120000', 10);

  console.log(`SAT test: ${count}x n=${n} ratio=${ratio} (m~${Math.round(n * ratio)}), ` +
    `limit ${timeLimitMs / 1000}s each`);
  let passed = 0;
  let totalMs = 0;
  let slowest = 0;
  for (let i = 0; i < count; i++) {
    const { clauses } = genSat(n, ratio);
    const t0 = Date.now();
    const sol = solveSat(n, clauses, { timeLimitMs });
    const ms = Date.now() - t0;
    totalMs += ms;
    if (ms > slowest) slowest = ms;
    const ok = sol !== null && checkAssignment(n, clauses, sol);
    if (ok) passed++;
    console.log(`  #${i + 1}: ${ok ? 'PASS' : 'FAIL'}  ${(ms / 1000).toFixed(2)}s` +
      (sol === null ? '  (no solution returned)' : '') +
      (sol !== null && !ok ? '  (assignment does NOT satisfy all clauses!)' : ''));
    if (ms > timeLimitMs) console.log(`     !! exceeded ${timeLimitMs / 1000}s limit`);
  }
  console.log(`TOTAL: ${passed}/${count} passed, ${(totalMs / 1000).toFixed(2)}s total, ` +
    `slowest ${(slowest / 1000).toFixed(2)}s`);
  process.exit(passed === count ? 0 : 1);
}

main();
