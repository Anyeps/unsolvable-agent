// check-and-run.js — one-shot window check (cron fallback, every 3 min).
// If a window is open with slots left and no attempt is running / no cooldown
// / not minted, spawns driver.js detached. Silent otherwise (exit 0).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const API = 'https://unsolvable.art';
const STATE_FILE = path.join(DIR, 'state.json');
const LOCK_FILE = path.join(DIR, 'attempt.lock');
const LOG_FILE = path.join(DIR, 'watcher.log');

function log(...a) {
  const line = `[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' })} WIB] [cron] ` + a.join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function lockLive() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return Date.now() - l.startedAt < 20 * 60e3;
  } catch { return false; }
}

(async () => {
  try {
    const r = await fetch(API + '/api/window');
    const w = await r.json();
    if (w.open !== true) return; // silent
    const slots = w.slotsLeft ?? w.slotsRemaining ?? w.slots ?? null;
    if (slots !== null && slots <= 0) { log('window open but no slots'); return; }
    const st = loadState();
    if (st.minted) return;
    if (st.cooldownUntil && Date.now() < st.cooldownUntil) { log('window open but cooldown active'); return; }
    if (lockLive()) return; // watcher/driver already on it
    log(`WINDOW OPEN (minted ${w.minted}/${w.maxSupply}, slots ${slots ?? '?'}) — spawning driver.js`);
    const child = spawn('node', ['driver.js'], { cwd: DIR, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.unref();
    log('driver spawned pid ' + child.pid);
  } catch (e) {
    log('check error: ' + String(e.message || e).slice(0, 200));
  }
})();
