'use strict';
/**
 * sat.js — 3-SAT solver for the UNSOLVABLE free-mint challenge.
 *
 * Hybrid solver, pure Node.js, zero dependencies:
 *   1. probSAT-style stochastic local search (SLS) — extremely fast on
 *      random planted-solution 3-SAT (the UNSOLVABLE instance family).
 *   2. Full CDCL fallback (watched literals, VSIDS, 1-UIP clause learning,
 *      Luby restarts, phase saving, learnt-clause reduction) — complete,
 *      so instances the local search cannot crack still get solved, and
 *      UNSAT is provable instead of a timeout guess.
 *
 * API:
 *   solveSat(n, clauses, opts?) -> '0'/'1' string of length n, or null
 *     clauses: array of arrays of 3 signed 1-indexed literals
 *              (-5 means NOT x5). opts.timeLimitMs (default 110000),
 *              opts.slsMs (SLS budget, default min(90000, 80% of limit)),
 *              opts.slsOnly / opts.cdclOnly (testing).
 *   checkAssignment(n, clauses, assignment) -> boolean
 *   solveSLS(n, clauses, deadlineMs, seed) -> string|null
 *   solveCDCL(n, clauses, deadlineMs) -> string|null (throws Error('timeout'))
 */

// ---------------------------------------------------------------- RNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromClauses(clauses) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    for (let j = 0; j < c.length; j++) {
      h ^= (c[j] + 0x9e3779b9) >>> 0;
      h = Math.imul(h, 16777619);
    }
    h ^= i + 0x85ebca6b; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- checker
function checkAssignment(n, clauses, s) {
  if (typeof s !== 'string' || s.length !== n) return false;
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    let ok = false;
    for (let j = 0; j < c.length; j++) {
      const lit = c[j];
      const v = lit < 0 ? -lit : lit;
      const val = s.charCodeAt(v - 1) - 48; // 0 or 1
      if ((lit > 0 && val === 1) || (lit < 0 && val === 0)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

// ================================================================ SLS
// probSAT: pick a random unsatisfied clause, flip one of its variables
// with probability proportional to (0.9 + break)^-2.06.
function solveSLS(n, clauses, deadlineMs, seed) {
  const m = clauses.length;
  if (m === 0) return '0'.repeat(n);
  const rand = mulberry32(seed >>> 0 || 1);

  // flat clauses + occurrence lists: occ[v] entries are (clauseIdx<<1)|isPos
  const flat = new Int32Array(m * 3);
  const occ = new Array(n);
  for (let v = 0; v < n; v++) occ[v] = [];
  for (let c = 0; c < m; c++) {
    const cl = clauses[c];
    for (let j = 0; j < 3; j++) {
      const lit = cl[j];
      flat[c * 3 + j] = lit;
      const v = (lit < 0 ? -lit : lit) - 1;
      occ[v].push((c << 1) | (lit > 0 ? 1 : 0));
    }
  }

  const assign = new Uint8Array(n);
  const satCount = new Int16Array(m);
  const unsat = new Int32Array(m);
  const unsatPos = new Int32Array(m);
  let unsatCount = 0;

  function initAssignment() {
    for (let v = 0; v < n; v++) assign[v] = rand() < 0.5 ? 1 : 0;
    unsatCount = 0;
    for (let c = 0; c < m; c++) unsatPos[c] = -1;
    for (let c = 0; c < m; c++) {
      let sc = 0;
      for (let j = 0; j < 3; j++) {
        const lit = flat[c * 3 + j];
        if (lit > 0 ? assign[lit - 1] === 1 : assign[-lit - 1] === 0) sc++;
      }
      satCount[c] = sc;
      if (sc === 0) { unsatPos[c] = unsatCount; unsat[unsatCount++] = c; }
    }
  }

  function unsatAdd(c) {
    unsatPos[c] = unsatCount;
    unsat[unsatCount++] = c;
  }
  function unsatRemove(c) {
    const p = unsatPos[c];
    const last = unsat[--unsatCount];
    unsat[p] = last;
    unsatPos[last] = p;
    unsatPos[c] = -1;
  }

  function flipVar(v) {
    const oldVal = assign[v];
    const newVal = oldVal ^ 1;
    assign[v] = newVal;
    const list = occ[v];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const c = e >> 1;
      const isPos = e & 1;
      const wasTrue = isPos ? oldVal === 1 : oldVal === 0;
      if (wasTrue) {
        if (satCount[c] === 1) unsatAdd(c); // 1 -> 0
        satCount[c]--;
      } else {
        if (satCount[c] === 0) unsatRemove(c); // 0 -> 1
        satCount[c]++;
      }
    }
  }

  function breakCount(v) {
    const cur = assign[v];
    const list = occ[v];
    let br = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const c = e >> 1;
      if (satCount[c] !== 1) continue;
      const isPos = e & 1;
      const litTrue = isPos ? cur === 1 : cur === 0;
      if (litTrue) br++;
    }
    return br;
  }

  const FLIPS_PER_TRY = 2000000;
  let totalFlips = 0;
  initAssignment();
  if (unsatCount === 0) return assignmentString();

  function assignmentString() {
    let s = '';
    for (let v = 0; v < n; v++) s += assign[v] ? '1' : '0';
    return s;
  }

  for (;;) {
    let flipsThisTry = 0;
    while (flipsThisTry < FLIPS_PER_TRY) {
      if (unsatCount === 0) return assignmentString();
      if ((flipsThisTry & 4095) === 0 && Date.now() > deadlineMs) return null;
      // pick random unsatisfied clause
      const c = unsat[(rand() * unsatCount) | 0];
      const base = c * 3;
      const l0 = flat[base], l1 = flat[base + 1], l2 = flat[base + 2];
      const v0 = (l0 < 0 ? -l0 : l0) - 1;
      const v1 = (l1 < 0 ? -l1 : l1) - 1;
      const v2 = (l2 < 0 ? -l2 : l2) - 1;
      const b0 = breakCount(v0);
      const b1 = breakCount(v1);
      const b2 = breakCount(v2);
      const w0 = Math.pow(0.9 + b0, -2.06);
      const w1 = Math.pow(0.9 + b1, -2.06);
      const w2 = Math.pow(0.9 + b2, -2.06);
      const tot = w0 + w1 + w2;
      let r = rand() * tot;
      let pick;
      if ((r -= w0) < 0) pick = v0;
      else if ((r -= w1) < 0) pick = v1;
      else pick = v2;
      flipVar(pick);
      flipsThisTry++;
      totalFlips++;
    }
    // restart with a fresh random assignment
    if (Date.now() > deadlineMs) return null;
    initAssignment();
    if (unsatCount === 0) return assignmentString();
  }
}

// ================================================================ CDCL
function luby(i) {
  // 1-indexed Luby sequence
  let k = 1;
  while ((1 << k) - 1 < i) k++;
  if ((1 << k) - 1 === i) return 1 << (k - 1);
  return luby(i - (1 << (k - 1)) + 1);
}

class CDCL {
  constructor(n, clauses, deadlineMs) {
    this.n = n;
    this.deadlineMs = deadlineMs;
    this.assign = new Int8Array(n).fill(-1);
    this.level = new Int32Array(n);
    this.reason = new Int32Array(n).fill(-1);
    this.phase = new Uint8Array(n); // saved phase (default 0)
    this.activity = new Float64Array(n);
    this.trail = [];
    this.trailLim = [];
    this.qhead = 0;
    this.clauses = []; // {lits:number[], learnt:boolean, deleted:boolean}
    this.watches = new Array(2 * n);
    for (let i = 0; i < 2 * n; i++) this.watches[i] = [];
    this.seen = new Uint8Array(n);
    this.conflicts = 0;
    this.decisions = 0;
    this.varInc = 1;
    this.varDecay = 0.95;
    this.learntCount = 0;
    this.lubyIdx = 1;
    this.conflictsSinceRestart = 0;
    this.restartLimit = 100;
    this.iter = 0;
    // VSIDS max-heap (lazy: assigned vars stay in heap, skipped on pop)
    this.heap = [];
    this.heapPos = new Int32Array(n).fill(-1);
    for (let v = 0; v < n; v++) this.heapInsert(v);
    this.units = [];
    this.ok = true;

    for (const raw of clauses) {
      // dedupe + tautology check
      const seenLit = new Set();
      let taut = false;
      const lits = [];
      for (const s of raw) {
        const lit = s > 0 ? ((s - 1) << 1) : (((-s - 1) << 1) | 1);
        if (seenLit.has(lit ^ 1)) { taut = true; break; }
        if (!seenLit.has(lit)) { seenLit.add(lit); lits.push(lit); }
      }
      if (taut) continue;
      if (lits.length === 0) { this.ok = false; return; }
      if (lits.length === 1) { this.units.push(lits[0]); continue; }
      this.addClause(lits, false);
    }
  }

  // ---- heap ----
  heapSwap(i, j) {
    const h = this.heap;
    const tmp = h[i]; h[i] = h[j]; h[j] = tmp;
    this.heapPos[h[i]] = i; this.heapPos[h[j]] = j;
  }
  heapUp(i) {
    const h = this.heap, a = this.activity;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[h[p]] >= a[h[i]]) break;
      this.heapSwap(i, p); i = p;
    }
  }
  heapDown(i) {
    const h = this.heap, a = this.activity;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && a[h[l]] > a[h[m]]) m = l;
      if (r < h.length && a[h[r]] > a[h[m]]) m = r;
      if (m === i) break;
      this.heapSwap(i, m); i = m;
    }
  }
  heapInsert(v) {
    if (this.heapPos[v] !== -1) return;
    this.heapPos[v] = this.heap.length;
    this.heap.push(v);
    this.heapUp(this.heap.length - 1);
  }
  heapPopMax() {
    while (this.heap.length > 0) {
      const top = this.heap[0];
      const last = this.heap.pop();
      this.heapPos[top] = -1;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        this.heapPos[last] = 0;
        this.heapDown(0);
      }
      if (this.assign[top] === -1) return top;
      // assigned var: dropped from heap; reinserted on backtrack
    }
    return -1;
  }
  bumpActivity(v) {
    this.activity[v] += this.varInc;
    if (this.activity[v] > 1e100) {
      for (let i = 0; i < this.n; i++) this.activity[i] *= 1e-100;
      this.varInc *= 1e-100;
    }
    const p = this.heapPos[v];
    if (p !== -1) this.heapUp(p);
  }

  // ---- literals ----
  litTrue(lit) {
    const a = this.assign[lit >> 1];
    return a !== -1 && a === ((lit & 1) ? 0 : 1);
  }
  litFalse(lit) {
    const a = this.assign[lit >> 1];
    return a !== -1 && a !== ((lit & 1) ? 0 : 1);
  }
  decisionLevel() { return this.trailLim.length; }

  addClause(lits, learnt) {
    const id = this.clauses.length;
    this.clauses.push({ lits, learnt, deleted: false });
    this.watches[lits[0]].push(id);
    this.watches[lits[1]].push(id);
    if (learnt) this.learntCount++;
    return id;
  }

  enqueue(lit, reasonCid) {
    const v = lit >> 1;
    const val = (lit & 1) ? 0 : 1;
    if (this.assign[v] !== -1) return this.assign[v] === val;
    this.assign[v] = val;
    this.level[v] = this.decisionLevel();
    this.reason[v] = reasonCid;
    this.phase[v] = val;
    this.trail.push(lit);
    return true;
  }

  propagate() {
    const trail = this.trail;
    while (this.qhead < trail.length) {
      const p = trail[this.qhead++];
      const falseLit = p ^ 1;
      const w = this.watches[falseLit];
      let j = 0;
      for (let i = 0; i < w.length; i++) {
        const cid = w[i];
        const cl = this.clauses[cid];
        if (cl.deleted) continue;
        const lits = cl.lits;
        // ensure the false literal is at index 1
        if (lits[0] === falseLit) { const t = lits[0]; lits[0] = lits[1]; lits[1] = t; }
        if (this.litTrue(lits[0])) { w[j++] = cid; continue; }
        // find a replacement watch
        let found = -1;
        for (let k = 2; k < lits.length; k++) {
          if (!this.litFalse(lits[k])) { found = k; break; }
        }
        if (found !== -1) {
          const t = lits[1]; lits[1] = lits[found]; lits[found] = t;
          this.watches[lits[1]].push(cid);
          continue;
        }
        w[j++] = cid;
        if (this.litFalse(lits[0])) {
          // conflict: keep the rest of the watch list intact
          for (let k = i + 1; k < w.length; k++) w[j++] = w[k];
          w.length = j;
          return cid;
        }
        // unit: propagate lits[0]
        if (!this.enqueue(lits[0], cid)) {
          for (let k = i + 1; k < w.length; k++) w[j++] = w[k];
          w.length = j;
          return cid;
        }
      }
      w.length = j;
    }
    return -1;
  }

  analyze(conflictCid) {
    const learnt = [0];
    const trail = this.trail;
    let index = trail.length - 1;
    let p = -1;
    let pathC = 0;
    let c = conflictCid;
    do {
      const lits = this.clauses[c].lits;
      for (let j = (p === -1 ? 0 : 1); j < lits.length; j++) {
        const q = lits[j];
        const v = q >> 1;
        if (!this.seen[v] && this.level[v] > 0) {
          this.bumpActivity(v);
          this.seen[v] = 1;
          if (this.level[v] >= this.decisionLevel()) pathC++;
          else learnt.push(q);
        }
      }
      while (index >= 0 && !this.seen[trail[index] >> 1]) index--;
      p = trail[index];
      this.seen[p >> 1] = 0;
      pathC--;
      index--;
      if (pathC > 0) {
        const r = this.reason[p >> 1];
        if (r === -1) break; // decision var; should not happen with pathC>0
        c = r;
      }
    } while (pathC > 0);
    learnt[0] = p ^ 1;
    for (let j = 1; j < learnt.length; j++) this.seen[learnt[j] >> 1] = 0;
    return learnt;
  }

  cancelUntil(lvl) {
    while (this.trailLim.length > lvl) {
      const start = this.trailLim[this.trailLim.length - 1];
      this.trailLim.pop();
      for (let i = this.trail.length - 1; i >= start; i--) {
        const v = this.trail[i] >> 1;
        this.assign[v] = -1;
        this.reason[v] = -1;
        this.heapInsert(v);
      }
      this.trail.length = start;
    }
    this.qhead = this.trail.length;
  }

  reduceDB() {
    if (this.learntCount < 2000) return;
    // never delete a clause that is currently a reason for an assigned var
    const inUse = new Set();
    for (let v = 0; v < this.n; v++) {
      if (this.reason[v] !== -1) inUse.add(this.reason[v]);
    }
    const cands = [];
    for (let id = 0; id < this.clauses.length; id++) {
      const cl = this.clauses[id];
      if (cl.learnt && !cl.deleted && !inUse.has(id)) cands.push(id);
    }
    cands.sort((a, b) => this.clauses[b].lits.length - this.clauses[a].lits.length);
    const toDelete = Math.floor(cands.length / 2);
    for (let i = 0; i < toDelete; i++) {
      this.clauses[cands[i]].deleted = true;
      this.learntCount--;
    }
  }

  solve() {
    if (!this.ok) return null;
    for (const u of this.units) {
      if (!this.enqueue(u, -1)) return null;
    }
    if (this.propagate() !== -1) return null;

    for (;;) {
      if ((++this.iter & 511) === 0 && this.deadlineMs && Date.now() > this.deadlineMs) {
        throw new Error('timeout');
      }
      const confl = this.propagate();
      if (confl !== -1) {
        this.conflicts++;
        this.conflictsSinceRestart++;
        if (this.decisionLevel() === 0) return null; // UNSAT
        const learnt = this.analyze(confl);
        // backtrack level = max level among learnt[1..]
        let btLevel = 0;
        let maxIdx = 1;
        for (let i = 1; i < learnt.length; i++) {
          const lv = this.level[learnt[i] >> 1];
          if (lv > btLevel) { btLevel = lv; maxIdx = i; }
        }
        this.cancelUntil(btLevel);
        this.varInc *= 1 / this.varDecay;
        if (learnt.length === 1) {
          this.enqueue(learnt[0], -1);
        } else {
          // move the max-level literal to position 1 (second watch)
          const t = learnt[1]; learnt[1] = learnt[maxIdx]; learnt[maxIdx] = t;
          const cid = this.addClause(learnt, true);
          this.enqueue(learnt[0], cid);
        }
        if (this.conflictsSinceRestart >= this.restartLimit) {
          this.cancelUntil(0);
          this.restartLimit = luby(++this.lubyIdx) * 100;
          this.conflictsSinceRestart = 0;
          this.reduceDB();
        }
      } else {
        const v = this.heapPopMax();
        if (v === -1) {
          // all assigned: SAT
          let s = '';
          for (let i = 0; i < this.n; i++) s += this.assign[i] === 1 ? '1' : '0';
          return s;
        }
        this.decisions++;
        this.trailLim.push(this.trail.length);
        this.enqueue(this.phase[v] ? (v << 1) : ((v << 1) | 1), -1);
      }
    }
  }
}

function solveCDCL(n, clauses, deadlineMs) {
  if (clauses.length === 0) return '0'.repeat(n);
  const solver = new CDCL(n, clauses, deadlineMs);
  return solver.solve();
}

// ================================================================ entry
function solveSat(n, clauses, opts = {}) {
  const timeLimitMs = opts.timeLimitMs != null ? opts.timeLimitMs : 110000;
  const deadline = Date.now() + timeLimitMs;
  if (clauses.length === 0) return '0'.repeat(n);

  if (opts.cdclOnly) {
    try { return solveCDCL(n, clauses, deadline); }
    catch (e) { if (e.message === 'timeout') return null; throw e; }
  }

  // SLS is the workhorse for random planted 3-SAT: it typically cracks
  // tier-1 instances in well under a second, while CDCL alone cannot
  // finish them in 60s (verified). So SLS gets ~80% of the budget and
  // CDCL only the tail as a completeness safety net.
  const slsMs = opts.slsMs != null
    ? opts.slsMs
    : Math.min(90000, Math.floor(timeLimitMs * 0.8));
  if (!opts.cdclOnly && slsMs > 0) {
    const seed = seedFromClauses(clauses) ^ 0x9e3779b9;
    const sls = solveSLS(n, clauses, Date.now() + slsMs, seed);
    if (sls) return sls;
  }
  if (opts.slsOnly) return null;

  try { return solveCDCL(n, clauses, deadline); }
  catch (e) { if (e.message === 'timeout') return null; throw e; }
}

module.exports = { solveSat, solveSLS, solveCDCL, checkAssignment, seedFromClauses };
