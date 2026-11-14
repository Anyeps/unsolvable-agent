// driver.js — UNSOLVABLE full attempt driver.
//   node driver.js
// Flow: window pre-check -> already-minted check -> login (baw EIP-712) ->
// POST /api/attempt -> solve stage 1 -> stage 2 -> stage 3 VDF -> lottery ->
// on win: mint on-chain value 0 via ../fire.js (preview -> execute once).
// Logs everything to attempts.log. Exit codes:
//   0 minted (or clean no-op) · 1 failed · 2 NEEDS_DEV_MODE · 3 NEEDS_APP_APPROVAL
//   4 nothing to do (window closed / cooldown / already minted)
// Safety: never signs anything except the login challenge; mint value is 0;
// one attempt at a time (lock file); respects the 15-min cooldown.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('../lib');
const { login, ADDRESS, API } = require('./login');

const DIR = __dirname;
const NFT = '0x9e95Da84f1bcc8E5570DAAc99A37EB3f95270904';
const STATE_FILE = path.join(DIR, 'state.json');
const LOCK_FILE = path.join(DIR, 'attempt.lock');
const LOG_FILE = path.join(DIR, 'attempts.log');
const BAW_BIN_DIR = '/home/hatch/workspace/tools/baw/node_modules/.bin';

function log(...a) {
  const line = `[${L.wib()}] ` + a.map(x => typeof x === 'string' ? x : L.safeJson(x)).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
}
function apiJson(method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async r => {
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      return { status: r.status, ok: r.ok, json: j, text: text.slice(0, 4000) };
    });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Server sometimes sends epoch seconds as a NUMBER (e.g. deadline 1794585145);
// Date.parse(number) -> NaN -> new Date(NaN).toISOString() throws RangeError
// and kills the driver AFTER the attempt registered server-side (zombie attempt
// then blocks retries with ATTEMPT_ACTIVE until its deadline). Normalise both forms.
function toMs(v, fallbackMs) {
  if (v === undefined || v === null || v === '') return fallbackMs;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : fallbackMs;
}

// ---- lock ----
function takeLock() {
  try {
    const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (Date.now() - old.startedAt < 20 * 60e3) return false; // live attempt
    log('stale lock (>20min) from pid', old.pid, '— taking over');
  } catch {}
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return true;
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }

// ---- solvers (loaded lazily; missing file = abort, never submit garbage) ----
function needSolver(name) {
  const f = path.join(DIR, name);
  if (!fs.existsSync(f)) throw new Error('solver missing: ' + f + ' — aborting attempt');
  return require(f);
}

// Find the puzzle object inside an attempt/answer response (shape is defensive).
function findPuzzle(resp) {
  if (!resp || typeof resp !== 'object') return null;
  for (const k of ['puzzle', 'stage1', 'stage2', 'stage3', 'nextPuzzle', 'next', 'data']) {
    const v = resp[k];
    if (v && typeof v === 'object' && (v.type || v.modulus || v.clauses || v.edges || v.numbers)) return v;
  }
  if (resp.type || resp.modulus || resp.clauses || resp.edges || resp.numbers) return resp;
  return null;
}
function findVdf(resp) {
  const p = findPuzzle(resp);
  if (p && p.modulus && p.x !== undefined && p.T !== undefined) return p;
  for (const k of ['vdf', 'stage3']) {
    const v = resp && resp[k];
    if (v && v.modulus) return v;
  }
  return null;
}

async function solveStage1or2(stage, puzzle) {
  const type = puzzle.type;
  const t0 = Date.now();
  let answer;
  if (type === 'sat') {
    const { solveSat } = needSolver('sat.js');
    answer = solveSat(puzzle.variables, puzzle.clauses);
  } else if (type === 'coloring') {
    const { solveColoring } = needSolver('coloring.js');
    answer = solveColoring(puzzle.vertices, puzzle.edges);
  } else if (type === 'subset') {
    const { solveSubset } = needSolver('subset.js');
    answer = solveSubset(puzzle.numbers, puzzle.target);
  } else {
    throw new Error('unknown puzzle type: ' + type);
  }
  if (typeof answer !== 'string' || !answer.length) throw new Error('solver returned no answer for ' + type);
  log(`stage ${stage} (${type}) solved in ${((Date.now() - t0) / 1000).toFixed(1)}s, answer len ${answer.length}`);
  return answer;
}

async function solveVdf(p) {
  const { computeVdf } = needSolver('vdf.js');
  const t0 = Date.now();
  const out = await computeVdf(String(p.x), Number(p.T), String(p.modulus));
  log(`VDF T=${p.T} computed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return out; // {y, proof} as 0x hex
}

function runFire(calldata) {
  return new Promise(resolve => {
    const env = { ...process.env, PATH: BAW_BIN_DIR + ':' + process.env.PATH };
    const args = ['../fire.js', '--to', NFT, '--data', calldata, '--value', '0', '--once', '--label', 'unsolvable'];
    const t0 = Date.now();
    const child = spawn('node', args, { cwd: DIR, env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}

(async () => {
  const state = loadState();
  if (state.minted) { log('STOP already minted (tx ' + (state.mintedTx || '?') + ')'); process.exit(4); }
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    log('STOP cooldown until ' + new Date(state.cooldownUntil).toISOString());
    process.exit(4);
  }
  if (!takeLock()) { log('STOP another attempt is running (lock present)'); process.exit(4); }
  const tStart = Date.now();
  let token = null;
  try {
    // 0. window still open? (cheap, saves a signature if it just closed)
    const w = await apiJson('GET', '/api/window');
    if (w.json && w.json.open === false) { log('STOP window closed (minted ' + w.json.minted + '/' + w.json.maxSupply + ')'); process.exitCode = 4; return; }
    log('window check:', JSON.stringify(w.json || w.text).slice(0, 300));

    // 0b. already minted on-chain? (definitive)
    try {
      const iface = new L.ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const res = await L.rpc('eth_call', [{ to: NFT, data: iface.encodeFunctionData('balanceOf', [ADDRESS]) }, 'latest']);
      const bal = iface.decodeFunctionResult('balanceOf', res)[0];
      if (bal > 0n) {
        log('STOP wallet already owns ' + bal.toString() + ' UNSOLVABLE NFT(s) on-chain');
        saveState({ ...state, minted: true, mintedTx: 'on-chain-check' });
        process.exitCode = 4; return;
      }
      log('on-chain balanceOf = 0 (not minted yet)');
    } catch (e) { log('WARN balanceOf check failed, continuing:', String(e.message || e).slice(0, 200)); }

    // 1. login
    const lg = await login();
    token = lg.token;
    log('login OK');

    // 2. start attempt
    let at = await apiJson('POST', '/api/attempt', {}, token);
    if (!at.ok) {
      const code = (at.json && (at.json.code || at.json.error)) || '';
      log('attempt start failed: HTTP ' + at.status + ' ' + (at.text || '').slice(0, 500));
      if (/COOLDOWN/i.test(code + at.text)) {
        const until = (at.json && at.json.until) ? toMs(at.json.until, Date.now() + 900e3) : Date.now() + 900e3;
        saveState({ ...state, cooldownUntil: until });
        log('cooldown until ' + new Date(until).toISOString());
      }
      process.exitCode = 1; return;
    }
    const attemptId = at.json.attemptId || at.json.id;
    const deadlineMs = at.json.deadline ? toMs(at.json.deadline, Date.now() + 480e3) : Date.now() + 480e3;
    log('attempt ' + attemptId + ' deadline ' + new Date(deadlineMs).toISOString() + ' (' + Math.round((deadlineMs - Date.now()) / 1000) + 's left)');
    log('attempt response: ' + JSON.stringify(at.json).slice(0, 2000));
    let puzzle = findPuzzle(at.json);
    if (!puzzle) { log('STOP cannot find stage-1 puzzle in response'); process.exitCode = 1; return; }

    // 3. stage 1 + stage 2
    for (const stage of [1, 2]) {
      if (Date.now() > deadlineMs - 30000) { log('STOP too close to deadline before stage ' + stage); process.exitCode = 1; return; }
      const answer = await solveStage1or2(stage, puzzle);
      const ans = await apiJson('POST', `/api/attempt/${attemptId}/answer`, { stage, answer }, token);
      log('stage ' + stage + ' answer response: HTTP ' + ans.status + ' ' + JSON.stringify(ans.json || ans.text).slice(0, 2000));
      if (!ans.ok) {
        const txt = (ans.text || '') + JSON.stringify(ans.json || '');
        if (/WRONG_ANSWER/i.test(txt)) { log('WRONG_ANSWER stage ' + stage + ' — cooldown 15m'); saveState({ ...state, cooldownUntil: Date.now() + 900e3, lastResult: 'wrong-answer-s' + stage }); }
        else if (/TIMEOUT/i.test(txt)) { log('TIMEOUT'); saveState({ ...state, cooldownUntil: Date.now() + 900e3, lastResult: 'timeout' }); }
        else if (/TIER_CHANGED/i.test(txt)) { log('TIER_CHANGED — no cooldown, can retry next window'); }
        else { log('answer failed, treating as cooldown'); saveState({ ...state, cooldownUntil: Date.now() + 900e3, lastResult: 'answer-failed-s' + stage }); }
        process.exitCode = 1; return;
      }
      if (stage === 2) {
        const vdf = findVdf(ans.json);
        if (!vdf) { log('STOP cannot find VDF params after stage 2'); process.exitCode = 1; return; }
        puzzle = vdf;
        break;
      }
      const next = findPuzzle(ans.json);
      if (!next) { log('STOP cannot find stage-2 puzzle in response'); process.exitCode = 1; return; }
      puzzle = next;
    }

    // 4. stage 3 VDF
    if (Date.now() > deadlineMs - 60000) { log('STOP too close to deadline before VDF'); process.exitCode = 1; return; }
    const vdfOut = await solveVdf(puzzle);
    const v3 = await apiJson('POST', `/api/attempt/${attemptId}/answer`, { stage: 3, y: vdfOut.y, proof: vdfOut.proof }, token);
    log('stage 3 answer response: HTTP ' + v3.status + ' ' + JSON.stringify(v3.json || v3.text).slice(0, 3000));
    if (!v3.ok) {
      const txt = (v3.text || '') + JSON.stringify(v3.json || '');
      if (/TIER_CHANGED/i.test(txt)) log('TIER_CHANGED after VDF — no cooldown');
      else { log('stage 3 failed — cooldown 15m'); saveState({ ...state, cooldownUntil: Date.now() + 900e3, lastResult: 'vdf-failed' }); }
      process.exitCode = 1; return;
    }

    // 5. lottery result
    const r3 = v3.json || {};
    const permit = r3.permit || r3.mintPermit || (r3.result && r3.result.permit);
    const sig = r3.signature || r3.permitSignature || (r3.result && r3.result.signature);
    const won = !!permit || r3.win === true || (r3.lottery && r3.lottery.win === true);
    if (!won) {
      log('LOTTERY LOST (or no permit in response) — cooldown 15m. Full response logged above.');
      saveState({ ...state, cooldownUntil: Date.now() + 900e3, lastResult: 'lottery-lost', lastAttempt: attemptId });
      process.exitCode = 1; return;
    }
    log('LOTTERY WON! permit received, valid 5 min. permit=' + JSON.stringify(permit).slice(0, 800));

    // 6. mint on-chain, value 0, via fire.js (preview -> execute once)
    if (String(permit.minter || '').toLowerCase() !== ADDRESS.toLowerCase()) {
      log('STOP permit.minter ' + permit.minter + ' != our wallet — NOT minting');
      process.exitCode = 1; return;
    }
    if (permit.deadline && Date.now() > Number(permit.deadline) * 1000 - 30000) {
      log('STOP permit deadline too close (' + permit.deadline + ') — NOT minting');
      process.exitCode = 1; return;
    }
    const ptype = typeof permit.puzzleType === 'string'
      ? ({ sat: 0, coloring: 1, subset: 2 }[permit.puzzleType.toLowerCase()] ?? 0)
      : Number(permit.puzzleType);
    if (typeof permit.puzzleType === 'string') log('WARN puzzleType was string "' + permit.puzzleType + '" mapped to ' + ptype);
    const tuple = [
      permit.minter,
      BigInt(permit.agentId),
      BigInt(permit.windowId),
      Number(permit.difficulty),
      ptype,
      Number(permit.solveTime),
      Number(permit.attempts),
      permit.solutionHash,
      BigInt(permit.deadline),
      permit.nonce,
    ];
    const iface = new L.ethers.Interface([
      'function mint((address minter,uint256 agentId,uint64 windowId,uint8 difficulty,uint8 puzzleType,uint32 solveTime,uint16 attempts,bytes32 solutionHash,uint64 deadline,bytes32 nonce) p, bytes sig)',
    ]);
    const calldata = iface.encodeFunctionData('mint', [tuple, sig]);
    log('mint calldata ready (' + calldata.length + ' chars), firing via fire.js --once, value 0');
    const fr = await runFire(calldata);
    log('fire.js exit ' + fr.code + ' in ' + fr.ms + 'ms:\n' + (fr.out || '').slice(-3000) + (fr.err ? '\nSTDERR: ' + fr.err.slice(-1000) : ''));
    const m = (fr.out || '').match(/0x[0-9a-fA-F]{64}/g);
    const txHash = m ? m[m.length - 1] : null;
    if (fr.code === 0 && /RECEIPT status SUCCESS/.test(fr.out || '')) {
      log('MINTED! tx ' + txHash + ' https://bscscan.com/tx/' + txHash);
      saveState({ ...state, minted: true, mintedTx: txHash, lastResult: 'minted', lastAttempt: attemptId });
      process.exitCode = 0; return;
    }
    log('MINT FAILED or unclear (fire.js exit ' + fr.code + '). Permit may still be valid for ~5 min — NOT auto-retrying; needs human review.');
    saveState({ ...state, lastResult: 'mint-fire-failed', lastAttempt: attemptId });
    process.exitCode = 1; return;
  } catch (e) {
    if (e.code === 'NEEDS_DEV_MODE') { log('BLOCKED NEEDS_DEV_MODE: ' + e.message); process.exitCode = 2; return; }
    if (e.code === 'NEEDS_APP_APPROVAL') { log('BLOCKED NEEDS_APP_APPROVAL: ' + e.message); process.exitCode = 3; return; }
    log('DRIVER ERROR: ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    releaseLock();
    log('driver done in ' + ((Date.now() - tStart) / 1000).toFixed(1) + 's, exit ' + (process.exitCode || 0));
  }
})();
