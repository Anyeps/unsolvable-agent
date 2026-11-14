// watch.js — UNSOLVABLE window watcher (persistent process).
// Polls GET /api/window every 30s; when a window is open with slots left and
// no attempt is running / no cooldown / not minted, spawns driver.js detached.
// Run: nohup node watch.js >> watcher.log 2>&1 &
// Logs only state changes + spawns + a heartbeat every 30 min (no spam).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const API = 'https://unsolvable.art';
const POLL_MS = 30000;
const LOG_FILE = path.join(DIR, 'watcher.log');
const STATE_FILE = path.join(DIR, 'state.json');
const LOCK_FILE = path.join(DIR, 'attempt.lock');

function log(...a) {
  const line = `[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' })} WIB] ` + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function lockLive() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return Date.now() - l.startedAt < 20 * 60e3;
  } catch { return false; }
}

let lastOpen = null;
let lastHeartbeat = 0;

async function tick() {
  try {
    const r = await fetch(API + '/api/window');
    const w = await r.json();
    const open = w.open === true;
    const slots = w.slotsLeft ?? w.slotsRemaining ?? w.slots ?? null;
    if (open !== lastOpen) {
      log(open ? `WINDOW OPEN (minted ${w.minted}/${w.maxSupply}, slots ${slots ?? '?'})` : `window closed (minted ${w.minted}/${w.maxSupply})`);
      lastOpen = open;
    }
    if (open && (slots === null || slots > 0)) {
      const st = loadState();
      if (st.minted) { log('window open but already minted — standing down'); return; }
      if (st.cooldownUntil && Date.now() < st.cooldownUntil) {
        log(`window open but cooldown until ${new Date(st.cooldownUntil).toISOString()} — standing down`);
        return;
      }
      if (lockLive()) return; // driver already running
      log('spawning driver.js');
      const child = spawn('node', ['driver.js'], {
        cwd: DIR, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.unref();
      log('driver spawned pid ' + child.pid);
    }
  } catch (e) {
    log('poll error: ' + String(e.message || e).slice(0, 200));
  }
  if (Date.now() - lastHeartbeat > 30 * 60e3) {
    lastHeartbeat = Date.now();
    log('heartbeat: watcher alive, last window open=' + lastOpen);
  }
}

process.on('uncaughtException', e => log('uncaught: ' + String(e.stack || e).slice(0, 500)));
process.on('unhandledRejection', e => log('unhandled rejection: ' + String(e && e.stack || e).slice(0, 500)));
log('watcher started pid ' + process.pid + ' (poll 30s)');
tick();
setInterval(tick, POLL_MS);
