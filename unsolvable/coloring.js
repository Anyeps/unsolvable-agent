'use strict';
/**
 * coloring.js — 3-coloring solver for planted instances (n=1000, avg degree ~5.6).
 *
 * Strategy (hybrid, DSATUR is the complete core):
 *  1. Min-conflicts local search (fast path — planted instances fall quickly).
 *  2. DSATUR + backtracking with forward checking + unit propagation
 *     (complete search, used if local search stalls).
 *
 * Exports: solveColoring(n, edges) -> '0'/'1'/'2' string of length n, or null.
 * edges: array of [u, v] pairs, 0-indexed. Adjacent vertices must differ.
 * No dependencies, CommonJS.
 */

function buildAdj(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  const seen = new Set();
  for (const e of edges) {
    const u = e[0] | 0, v = e[1] | 0;
    if (u < 0 || v < 0 || u >= n || v >= n || u === v) continue;
    const key = u < v ? u * n + v : v * n + u;
    if (seen.has(key)) continue;
    seen.add(key);
    adj[u].push(v);
    adj[v].push(u);
  }
  return adj;
}

function verify(n, adj, color) {
  if (!color || color.length !== n) return false;
  for (let u = 0; u < n; u++) {
    const c = color[u];
    if (c < 0 || c > 2) return false;
    for (const v of adj[u]) {
      if (v > u && color[v] === c) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Min-conflicts local search
// ---------------------------------------------------------------------------
function minConflicts(n, adj, deadlineMs) {
  const color = new Int8Array(n);
  const conf = new Int32Array(n); // # neighbours with same colour
  // conflicted-vertex list with O(1) add/remove (swap-with-last + position map)
  const inList = new Uint8Array(n);
  const pos = new Int32Array(n);
  const list = [];
  const addConflicted = (v) => {
    if (inList[v]) return;
    inList[v] = 1; pos[v] = list.length; list.push(v);
  };
  const removeConflicted = (v) => {
    if (!inList[v]) return;
    inList[v] = 0;
    const p = pos[v], last = list[list.length - 1];
    list[p] = last; pos[last] = p; list.pop();
  };

  const neighbourColourCount = (v, c) => {
    let k = 0;
    for (const u of adj[v]) if (color[u] === c) k++;
    return k;
  };

  const totalConflicts = () => {
    let t = 0;
    for (let v = 0; v < n; v++) t += conf[v];
    return t / 2;
  };

  const MAX_RESTARTS = 40;
  for (let restart = 0; restart < MAX_RESTARTS; restart++) {
    if (Date.now() > deadlineMs) return null;
    // Greedy randomised init: colour in random order, pick least-conflict colour.
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    color.fill(-1);
    for (const v of order) {
      let best = 0, bestC = Infinity;
      // try colours in random order to break ties randomly
      const cs = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = cs[i]; cs[i] = cs[j]; cs[j] = tmp;
      }
      for (const c of cs) {
        const k = neighbourColourCount(v, c);
        if (k < bestC) { bestC = k; best = c; }
      }
      color[v] = best;
    }
    conf.fill(0);
    list.length = 0; inList.fill(0);
    for (let v = 0; v < n; v++) {
      conf[v] = neighbourColourCount(v, color[v]);
      if (conf[v] > 0) addConflicted(v);
    }
    if (list.length === 0) return color;

    const maxSteps = 400000;
    for (let step = 0; step < maxSteps; step++) {
      if (list.length === 0) return color;
      if ((step & 1023) === 0 && Date.now() > deadlineMs) return null;
      const v = list[(Math.random() * list.length) | 0];
      const cur = color[v];
      let bestC = Infinity;
      const counts = [0, 0, 0];
      for (let c = 0; c < 3; c++) counts[c] = neighbourColourCount(v, c);
      for (let c = 0; c < 3; c++) if (counts[c] < bestC) bestC = counts[c];
      let newC;
      if (Math.random() < 0.08) {
        // random walk step to escape local minima
        newC = (Math.random() * 3) | 0;
        if (newC === cur) newC = (cur + 1 + ((Math.random() * 2) | 0)) % 3;
      } else {
        const tied = [];
        for (let c = 0; c < 3; c++) if (counts[c] === bestC) tied.push(c);
        newC = tied[(Math.random() * tied.length) | 0];
        if (newC === cur && tied.length > 1) {
          // prefer an actual move when tied
          const others = tied.filter((c) => c !== cur);
          newC = others[(Math.random() * others.length) | 0];
        }
      }
      if (newC === cur) continue;
      // apply move, updating conflict counts incrementally
      for (const u of adj[v]) {
        if (color[u] === cur) { conf[u]--; }
        else if (color[u] === newC) { conf[u]++; }
        if (conf[u] > 0) addConflicted(u); else removeConflicted(u);
      }
      color[v] = newC;
      conf[v] = counts[newC];
      if (conf[v] > 0) addConflicted(v); else removeConflicted(v);
    }
    // restart with a fresh randomised greedy init
  }
  return null;
}

// ---------------------------------------------------------------------------
// DSATUR + backtracking with forward checking + unit propagation
// ---------------------------------------------------------------------------
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3];

function dsatur(n, adj, deadlineMs) {
  let nodes = 0;

  // Propagate an assignment through domains. Mutates `color`/`domains` in
  // place (caller passes copies). Returns false on conflict.
  function propagate(color, domains, startV, startC) {
    const queue = [[startV, startC]];
    let qh = 0;
    while (qh < queue.length) {
      const [u, cu] = queue[qh++];
      if (color[u] >= 0) {
        if (color[u] !== cu) return false;
        continue;
      }
      color[u] = cu;
      domains[u] = 1 << cu;
      for (const w of adj[u]) {
        if (color[w] >= 0) {
          if (color[w] === cu) return false;
          continue;
        }
        const before = domains[w];
        if (before & (1 << cu)) {
          const after = before & ~(1 << cu);
          if (after === 0) return false;
          domains[w] = after;
          if ((after & (after - 1)) === 0) {
            // singleton domain -> forced colour, propagate it
            queue.push([w, 31 - Math.clz32(after)]);
          }
        }
      }
    }
    return true;
  }

  function dfs(color, domains, coloured) {
    if (coloured === n) return color;
    if ((++nodes & 1023) === 0 && Date.now() > deadlineMs) throw new Error('timeout');

    // DSATUR selection: max saturation (distinct colours among coloured
    // neighbours), tie-break max uncoloured degree, then smallest domain.
    let bestV = -1, bestSat = -1, bestDeg = -1, bestDom = 99;
    for (let v = 0; v < n; v++) {
      if (color[v] >= 0) continue;
      let mask = 0, deg = 0;
      for (const u of adj[v]) {
        if (color[u] >= 0) mask |= 1 << color[u];
        else deg++;
      }
      const sat = POPCOUNT[mask];
      const dom = POPCOUNT[domains[v]];
      if (sat > bestSat || (sat === bestSat && (deg > bestDeg || (deg === bestDeg && dom < bestDom)))) {
        bestV = v; bestSat = sat; bestDeg = deg; bestDom = dom;
      }
    }
    const v = bestV;
    const dom = domains[v];

    // Try colours in least-constraining-value order: fewest neighbours that
    // would lose this colour (i.e. whose domain contains it).
    const cands = [];
    for (let c = 0; c < 3; c++) {
      if (!(dom & (1 << c))) continue;
      let cost = 0;
      for (const u of adj[v]) {
        if (color[u] < 0 && (domains[u] & (1 << c))) cost++;
      }
      cands.push([cost, c]);
    }
    cands.sort((a, b) => a[0] - b[0]);

    for (const [, c] of cands) {
      const nc = color.slice();
      const nd = domains.slice();
      if (!propagate(nc, nd, v, c)) continue;
      // count newly coloured vertices (propagation may colour several)
      let ncoloured = 0;
      for (let i = 0; i < n; i++) if (nc[i] >= 0) ncoloured++;
      const res = dfs(nc, nd, ncoloured);
      if (res) return res;
    }
    return null;
  }

  const color = new Int8Array(n).fill(-1);
  const domains = new Uint8Array(n).fill(0b111);
  // Seed with the highest-degree vertex coloured 0 (symmetry breaking).
  let seed = 0;
  for (let v = 1; v < n; v++) if (adj[v].length > adj[seed].length) seed = v;
  const c0 = color.slice(), d0 = domains.slice();
  if (!propagate(c0, d0, seed, 0)) return null;
  let ncoloured = 0;
  for (let i = 0; i < n; i++) if (c0[i] >= 0) ncoloured++;
  try {
    return dfs(c0, d0, ncoloured);
  } catch (e) {
    if (e && e.message === 'timeout') return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
function solveColoring(n, edges) {
  if (!Number.isInteger(n) || n <= 0) return null;
  if (n === 1) return '0';
  const adj = buildAdj(n, edges);
  const start = Date.now();
  // Fast path: min-conflicts, up to ~8s (planted instances usually <1s).
  const lc = minConflicts(n, adj, start + 8000);
  if (lc && verify(n, adj, lc)) {
    return Array.from(lc, (c) => String(c)).join('');
  }
  // Complete path: DSATUR + backtracking, rest of a ~55s budget.
  const res = dsatur(n, adj, start + 55000);
  if (res && verify(n, adj, res)) {
    return Array.from(res, (c) => String(c)).join('');
  }
  // One more local-search attempt with the remaining budget is not useful
  // after DSATUR consumed it; return null.
  return null;
}

module.exports = { solveColoring, _dsatur: dsatur, _minConflicts: minConflicts, _buildAdj: buildAdj };
