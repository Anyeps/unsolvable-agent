# unsolvable-agent

An autonomous agent that plays the **UNSOLVABLE** free mint on BSC, end to end —
no human in the loop from window open to on-chain mint.

UNSOLVABLE is a 3,333-supply free NFT mint (gas only, one per `.ai` Agent ID).
Mint windows open 6× a day at random, unannounced times, 15 minutes each,
80 slots. Each attempt is a 3-stage challenge against an 8-minute deadline,
then a 30% lottery for a 5-minute mint permit.

## How it works

```
watch.js (poll /api/window every 30s)
  └─ window open + slots left + no cooldown + not minted
       └─ driver.js
            ├─ 0. window still open? on-chain balanceOf = 0?
            ├─ 1. login: EIP-712 typed-data signature via the
            │     Binance Agentic Wallet CLI (baw) — no private key
            │     ever touches this machine
            ├─ 2. POST /api/attempt → stage-1 puzzle
            ├─ 3. stage 1 + 2: SAT / graph-coloring / subset-sum
            │     (see Solvers)
            ├─ 4. stage 3: Wesolowski VDF, RSA-2048, T = 4,000,000
            ├─ 5. 30% lottery → mint permit (5 min)
            └─ 6. mint on-chain, value 0, via fire.js
                  (preview → execute once, lock file, 15-min cooldown)
```

## Solvers (pure Node.js, zero dependencies unless noted)

| Stage | Puzzle | Solver |
|---|---|---|
| 1–2 | 3-SAT | `sat.js` — probSAT-style stochastic local search, with a **full CDCL fallback** (watched literals, VSIDS, 1-UIP learning, Luby restarts, phase saving). Complete, so UNSAT is provable, not a timeout guess. |
| 1–2 | Graph 3-coloring (n=1000) | `coloring.js` — min-conflicts local search + DSATUR with forward checking and unit propagation. |
| 1–2 | Subset-sum (n=36, BigInt) | `subset.js` — meet-in-the-middle, 2^18 per side. |
| 3 | Wesolowski VDF | `vdf.js` + `vdf_gmp.c` — `y = x^(2^T) mod N`, Wesolowski proof `π = x^⌊2^T/l⌋ mod N`. The GMP helper (`gcc -O3 -o vdf-gmp vdf_gmp.c -lgmp`) computes **T = 4,000,000 squarings in ~33.6 s**. |

Measured performance: a full attempt takes **~35–40 s of solving** against the
8-minute limit. `node test-sat.js` → 5/5 in 0.08 s. `node test-puzzles.js`
runs planted coloring/subset instances, VDF correctness against the server's
own verification equation, and the T=4,000,000 timing test — exit 0 only if
everything passes.

## Honest status (15 Nov 2026)

The agent works — the identical code logged in and attempted a window on
13 Nov. But **the mint server's auth has been broken since 14 Nov ~01:00 WIB**:
every login fails with HTTP 401 `NO_CHALLENGE` ("request /api/auth/challenge
first") even though a fresh challenge was fetched seconds earlier. All 6
windows on 14 Nov were missed by *everyone* — 0 of 80 slots taken in each,
minted stuck at **52/3,333** (verified live 15 Nov ~03:55 WIB, window closed).
The watcher (`watch.js`, 30 s poll) plus a 3-minute cron fallback
(`check-and-run.js`) stay armed and will fire the moment the server recovers.
This is a real agent running against a real, currently broken, server — the
broken part is theirs, and the logs prove it (`attempts.log` in the original
deployment, not included here).

## Verifiability by construction

This agent does not use zkVerify. Its claim is weaker but checkable today:
deterministic solvers with a reproducible test suite, every decision logged,
and — when it mints — an on-chain receipt (`balanceOf` + BscScan transaction)
that anyone can verify without trusting this repo. A Groth16 proof over the
same evidence would be the natural next step.

## Layout

The code is exactly the deployed agent, laid out as in the live `fastmint`
tree: the agent lives in `unsolvable/`, the shared helpers
(`lib.js`, `fire.js`, `ethers.umd.min.js`) at the repo root.

- `unsolvable/login.js` — EIP-712 login via `baw` (never runs `baw auth signin`)
- `unsolvable/driver.js` — one full attempt, exit codes 0 minted / 2 needs
  Developer Mode / 3 needs app approval / 4 nothing to do
- `unsolvable/watch.js` — persistent 30 s window watcher
- `unsolvable/check-and-run.js` — one-shot window check (cron fallback)
- `unsolvable/start-watcher.sh` — (re)start the watcher
- `unsolvable/sat.js`, `coloring.js`, `subset.js`, `vdf.js`, `vdf_gmp.c`
- `unsolvable/gen-sat.js`, `test-sat.js`, `test-puzzles.js` — generator + tests
- `lib.js` — RPC pool, WIB logging, `baw` runner, Agent ID lookup
- `fire.js` — one-shot contract call through `baw` on BSC (never broadcasts twice)

## Run it

```bash
# Node 18+, Binance Agentic Wallet CLI (baw) with Developer Mode on.
# Set ADDRESS in unsolvable/login.js to your own wallet (it must own an
# .ai Agent ID on the UNSOLVABLE registry), and point BAW at your baw binary.
gcc -O3 -o unsolvable/vdf-gmp unsolvable/vdf_gmp.c -lgmp   # optional, VDF helper
node unsolvable/test-puzzles.js                              # solvers must pass
bash unsolvable/start-watcher.sh                             # arm the watcher
```

## Safety

- Never signs anything except the login challenge; the mint transaction is
  value 0 and is previewed before execution.
- One attempt at a time (lock file); respects the server's 15-minute cooldown.
- No private keys, seed phrases, or credentials anywhere in this repo — the
  wallet signs inside the Binance App / `baw` CLI.

Built by Luna (AI agent) and Fah. Entered in the zkVerify Agent Games
Wildcard track.
