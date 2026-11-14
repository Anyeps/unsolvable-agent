// login.js — UNSOLVABLE login via Binance Agentic Wallet (EIP-712 typed data).
// Shared by driver.js. Also runnable standalone: `node login.js` prints the
// Bearer token or the exact blocker (NEEDS_DEV_MODE / NEEDS_APP_APPROVAL).
// Never runs `baw auth signin`. Never asks for a private key.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const API = 'https://unsolvable.art';
const ADDRESS = '0xC2B346278901012534De035421Be45f2Bd6348BF';
const BAW = '/home/hatch/workspace/tools/baw/node_modules/.bin/baw'; // persistent copy (authoritative; bare `baw` is NOT on PATH)

function bawJson(args, timeoutMs = 60000) {
  return new Promise(resolve => {
    const s = Date.now();
    execFile(BAW, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      let j = null;
      try { j = JSON.parse(out); } catch { const i = out.indexOf('{'); if (i >= 0) try { j = JSON.parse(out.slice(i)); } catch {} }
      resolve({ ok: !err && j && j.success === true, json: j, stdout: out, stderr: String(stderr || ''), err, ms: Date.now() - s });
    });
  });
}

async function apiJson(method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(API + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json: j, text: text.slice(0, 2000) };
}

// Returns { token } or throws an Error with .code:
//   NEEDS_DEV_MODE     — baw error 351801/351802 (enable Developer Mode in the Binance App)
//   NEEDS_APP_APPROVAL — execute returned PENDING_CONFIRMATION / requireConfirmation
//   SIGN_FAILED / VERIFY_FAILED — with server/baw details attached
async function login() {
  const ch = await apiJson('POST', '/api/auth/challenge', { address: ADDRESS });
  if (!ch.ok || !ch.json || !ch.json.typedData || !ch.json.nonce) {
    const e = new Error('challenge failed: HTTP ' + ch.status + ' ' + (ch.text || '').slice(0, 300));
    e.code = 'CHALLENGE_FAILED'; throw e;
  }
  const { typedData, nonce } = ch.json;
  const msg = JSON.stringify({
    method: 'eth_signTypedData_v4',
    params: [ADDRESS, JSON.stringify(typedData)],
  });
  const pv = await bawJson(['sign-message', 'preview', '--binanceChainId', '56', '--signType', 'EIP712', '--message', msg], 60000);
  if (!pv.ok || !pv.json || !pv.json.data || !pv.json.data.requestId) {
    const err = (pv.json && pv.json.error) || {};
    const txt = JSON.stringify(pv.json || pv.stdout || pv.stderr).slice(0, 400);
    if (err.code === 351801 || err.code === 351802 || /developer mode/i.test(txt)) {
      const e = new Error('Developer Mode is off/expired in the Binance App (baw ' + (err.code || '?') + '). Enable it: Binance App → Agentic Wallet → Settings → Developer Mode.');
      e.code = 'NEEDS_DEV_MODE'; e.detail = txt; throw e;
    }
    const e = new Error('sign preview failed: ' + txt);
    e.code = 'SIGN_FAILED'; e.detail = txt; throw e;
  }
  const requestId = pv.json.data.requestId;
  const ex = await bawJson(['sign-message', 'execute', '--requestId', requestId], 120000);
  const ed = ex.json && ex.json.data;
  if (!ex.ok || !ed || !ed.signature) {
    const err = (ex.json && ex.json.error) || {};
    const txt = JSON.stringify(ex.json || ex.stdout || ex.stderr).slice(0, 400);
    if (err.code === 351801 || err.code === 351802 || /developer mode/i.test(txt)) {
      const e = new Error('Developer Mode is off/expired (execute step).');
      e.code = 'NEEDS_DEV_MODE'; e.detail = txt; throw e;
    }
    const e = new Error('sign execute failed: ' + txt);
    e.code = 'SIGN_FAILED'; e.detail = txt; throw e;
  }
  if (ed.status === 'PENDING_CONFIRMATION' || ed.requireConfirmation) {
    const e = new Error('Sign needs approval in the Binance App (status PENDING_CONFIRMATION). Cannot auto-approve.');
    e.code = 'NEEDS_APP_APPROVAL'; e.requestId = requestId; throw e;
  }
  const signature = ed.signature; // 128 hex chars, r||s, no 0x
  const signatureRecovery = ed.signatureRecovery; // "00" | "01"
  const vf = await apiJson('POST', '/api/auth/verify', {
    address: ADDRESS,
    signature,
    signatureRecovery,
    nonce,
    scheme: 'eip712',
  });
  if (!vf.ok || !vf.json || !vf.json.token) {
    const e = new Error('verify failed: HTTP ' + vf.status + ' ' + (vf.text || '').slice(0, 300));
    e.code = 'VERIFY_FAILED'; throw e;
  }
  return { token: vf.json.token, nonce };
}

if (require.main === module) {
  (async () => {
    try {
      const { token } = await login();
      console.log('LOGIN OK token=' + token.slice(0, 20) + '... (len ' + token.length + ')');
      // quick proof the token works: agent status
      const st = await apiJson('GET', '/api/agent/status', null, token).catch(() => null);
      console.log('agent/status:', st ? st.status + ' ' + (st.text || '').slice(0, 300) : 'n/a');
    } catch (e) {
      console.error('LOGIN FAILED [' + (e.code || '?') + ']: ' + e.message);
      process.exit(e.code === 'NEEDS_DEV_MODE' ? 2 : e.code === 'NEEDS_APP_APPROVAL' ? 3 : 1);
    }
  })();
}

module.exports = { login, ADDRESS, API, BAW };
