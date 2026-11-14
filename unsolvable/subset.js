'use strict';
/**
 * subset.js — subset-sum solver, meet-in-the-middle.
 *
 * Exports: solveSubset(numbers, target) -> '0'/'1' string (one char per
 * number; chosen numbers sum exactly to target) or null.
 * numbers / target are decimal strings; values may be large (BigInt).
 * Split n/2 + n/2, hash-map on left-half sums. n=36 -> 2^18 per side.
 * No dependencies, CommonJS.
 */

function solveSubset(numbers, target) {
  if (!Array.isArray(numbers)) return null;
  const n = numbers.length;
  const t = BigInt(target);
  if (n === 0) return t === 0n ? '' : null;
  const a = numbers.map((s) => BigInt(s));

  // Trivial cases.
  if (t === 0n) return '0'.repeat(n);

  const n1 = Math.floor(n / 2);
  const n2 = n - n1;
  const left = a.slice(0, n1);
  const right = a.slice(n1);

  // Enumerate left-half subset sums, keeping the first mask per sum.
  // sums[mask] built incrementally via lowest set bit: O(2^n1).
  const sizeL = 1 << n1;
  const sumsL = new Array(sizeL);
  sumsL[0] = 0n;
  const map = new Map(); // sum (BigInt) -> mask (first seen)
  map.set(0n, 0);
  for (let mask = 1; mask < sizeL; mask++) {
    const lsb = mask & -mask;
    const bit = 31 - Math.clz32(lsb);
    const prev = mask ^ lsb;
    const s = sumsL[prev] + left[bit];
    sumsL[mask] = s;
    if (!map.has(s)) map.set(s, mask);
  }

  // Enumerate right-half sums, look up (target - sumR) in the left map.
  const sizeR = 1 << n2;
  const sumsR = new Array(sizeR);
  sumsR[0] = 0n;
  for (let mask = 0; mask < sizeR; mask++) {
    let s;
    if (mask === 0) {
      s = 0n;
    } else {
      const lsb = mask & -mask;
      const bit = 31 - Math.clz32(lsb);
      s = sumsR[mask ^ lsb] + right[bit];
      sumsR[mask] = s;
    }
    const need = t - s;
    const lm = map.get(need);
    if (lm !== undefined) {
      const out = new Array(n).fill('0');
      for (let i = 0; i < n1; i++) if (lm & (1 << i)) out[i] = '1';
      for (let i = 0; i < n2; i++) if (mask & (1 << i)) out[n1 + i] = '1';
      return out.join('');
    }
  }
  return null;
}

module.exports = { solveSubset };
