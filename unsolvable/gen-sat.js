'use strict';
/**
 * gen-sat.js — random 3-SAT generator with a planted solution.
 *
 * genSat(n, ratio, rng?) -> { n, clauses, solution }
 *   n: number of variables
 *   ratio: clauses/variables (UNSOVABLE tier 1 is ~5.2)
 *   rng: optional () => [0,1) random source (default Math.random)
 *   clauses: array of [lit, lit, lit], signed 1-indexed literals
 *   solution: the planted '0'/'1' assignment string (length n)
 *
 * Every generated clause is satisfied by the planted solution, so the
 * instance is satisfiable by construction.
 *
 * CLI: node gen-sat.js [n=1024] [ratio=5.2]
 *   prints JSON { n, clauses } to stdout (solution NOT printed, so the
 *   instance can be fed to a solver blind).
 */

function genSat(n, ratio, rng) {
  const rand = rng || Math.random;
  const m = Math.round(n * ratio);
  // planted solution
  let solution = '';
  const sol = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    sol[v] = rand() < 0.5 ? 1 : 0;
    solution += sol[v] ? '1' : '0';
  }
  const clauses = new Array(m);
  for (let c = 0; c < m; c++) {
    // 3 distinct variables
    let a = (rand() * n) | 0;
    let b = (rand() * n) | 0;
    while (b === a) b = (rand() * n) | 0;
    let d = (rand() * n) | 0;
    while (d === a || d === b) d = (rand() * n) | 0;
    const vars = [a, b, d];
    // random signs; resample until the clause is satisfied by the plant
    let lits;
    for (;;) {
      lits = vars.map((v) => (rand() < 0.5 ? v + 1 : -(v + 1)));
      let sat = false;
      for (const lit of lits) {
        if ((lit > 0 && sol[lit - 1] === 1) || (lit < 0 && sol[-lit - 1] === 0)) {
          sat = true;
          break;
        }
      }
      if (sat) break;
    }
    clauses[c] = lits;
  }
  return { n, clauses, solution };
}

module.exports = { genSat };

if (require.main === module) {
  const n = parseInt(process.argv[2] || '1024', 10);
  const ratio = parseFloat(process.argv[3] || '5.2');
  const { clauses } = genSat(n, ratio);
  process.stdout.write(JSON.stringify({ n, clauses }));
}
