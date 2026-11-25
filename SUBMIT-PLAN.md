# SUBMIT-PLAN — Boothlord Momentum Paper Bot

Competition: `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`
("Pump.fun Paper Sprint: Any Bot Can Win") — $2, winner-takes-all.
Deadline: 26 Nov 2026 12:40 WIB (2026-11-26T05:40:00Z).
Status: BUILD ONLY. Nothing bundled, nothing submitted. A finisher follows.

## Verified gate (from the kit's competition.yaml)

- Harness: `pumpfun-replay/v2`, protocol `agent-fun/replay/v2`; entrypoint
  `main.ts` on Node 22; the entry runs twice and the two action logs must
  match byte for byte (fully deterministic — no clock, no randomness).
- Paper capital: 10 SOL (10,000,000,000 lamports).
- Caps: at most 5 open positions; each batch's buys on one mint at most 1%
  (100 bps) of that mint's real SOL reserve; at most 16 orders per batch;
  no shorts, no leverage. Order latency: 2 slots.
- Minimum bar to rank: a round trip of at least 0.01 SOL on each of at
  least 20 distinct coins, and max drawdown at most 50%.
- Final scoring: net PnL on a fresh 6-hour pump.fun window collected after
  the deadline; a prize is paid only if net PnL is above 0 SOL.
- Submission rules: Force_Last (latest submission stands), max 5 per day,
  transcripts required, OSI license required, repo created after the
  competition opened (2026-11-24T05:37:28Z).
- Fees in replay: protocol 95 bps + creator 30 bps fallback, 5,000 +
  100,000 lamports tx fee per order, 2% seeded failed transactions.

## Strategy summary

Momentum with guardrails, written fresh for this entry (`main.ts` +
`strategy.ts`, SDK shim vendored unchanged at `vendor/makefun-bot.ts`):

- Entries only when the real SOL reserve is deep (>= 8 SOL) and growing
  (>= +2.5% over the recent trail, parabolic +150% blow-offs rejected) and
  recent flow is buyer-dominated (>= 66% of volume, buy-count edge >= 2).
- Clips: 0.09 SOL strongest signals, 0.06 SOL standard, 0.04 SOL breadth
  scouts (reserve >= 5 SOL, buy share >= 58%), always capped at 1% of the
  mint's real reserve and never below 0.02 SOL.
- Exits: hard stop at -10%; sell two thirds at +25%, trail the rest (exit
  on a 12% slide from peak value); instant full exit when the real reserve
  falls to 55% of its peak (rug signal); stale/flat time stops recycle
  capital (900-slot rotation, 2,400-slot max hold, 900 slots without a
  trade = abandon).
- Drawdown brake: new entries halt at ~25% drawdown from the equity peak.
- Breadth: fresh coins win candidate ties, exited coins cool down 30
  slots, max 3 entries per mint, scouts keep firing until ~24 round trips
  are banked — the 20-coin bar is cleared with margin (dev grade: 279).

## Local grade results (honest)

Graded with the kit's own grader on the frozen dev window (128,058
events), `--driver process` (no docker on this machine), `--worktree`,
no transcripts bundle (the finisher creates it; authorship/cost lines
therefore read 0/unpriced locally, as expected pre-bundle):

- First version: net PnL **-2.223 SOL** (return -22.2%, 90% interval
  -3.05 .. -1.36 SOL), 1,163 fills, 294 coins, 518 round trips, win rate
  28.2%, max drawdown 24.5%, fees 1.040 SOL curve + 0.126 SOL tx.
  Guardrails met; two executions reproduced byte for byte.
- Tuned version (SHIPPED): stricter flow floors (strict buy share 66%,
  growth floor +2.5%; scout buy share 58% with a positive buy-count edge)
  and a slower 900-slot rotation to cut fee bleed. Net PnL **-1.973 SOL**
  (return -19.7%, 90% interval -2.77 .. -1.09 SOL), 1,091 fills, 279
  coins, 483 round trips, win rate 29.0%, max drawdown 22.6%, fees
  0.984 SOL curve + 0.117 SOL tx. Guardrails met (279 coins over the
  20-coin bar, drawdown 22.6% under the 50% cap); L1 regrade reproduced
  the action log byte for byte (action_log_sha256
  7b9a89e2a6dec76ca961ecbec5a870da6d29be3e108df49aeb0cd68b84cd639c).

Read this honestly: on the dev calibration window the bot LOSES money —
it would not beat holding cash there, and no prize would be paid on a
window like it. The dev window is one small historical sample; the final
is a different, unseen 6-hour forward window where the result may differ
either way. No PnL figure is promised. The entry is valid, deterministic,
and clears every guardrail with wide margin; its dev-window expectancy is
negative, dominated by curve fees on a 29% win rate.

Sanity runs (synthetic protocol stream): the bot answers hello/batch/done
correctly, sized a strict-momentum buy at the 0.09 SOL strong clip under
the reserve cap, and sold exactly two thirds of the position at +35% —
the take-profit path — and repeated runs produced identical replies.

## About block (for the GitHub repo the finisher creates)

- Repo: `SRamadhan-07/makefun-pump-boothlord`
- Description (<= 350 chars): "Deterministic momentum bot for the make.fun
  Pump.fun Paper Sprint: buys deep, growing, buyer-dominated bonding curves
  in small clips, banks two thirds at +25%, stops at -10%, exits instantly
  on reserve collapse, and rotates across 20+ coins under a 25% drawdown
  brake. Node 22, agent-fun/replay/v2."
- Website: https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b
- Topics: makefun, ai-agents, bounties, growth
- Suggested entry title: "Boothlord Momentum Paper Bot"

## Finisher checklist

1. Create the public GitHub repo above (after the competition opened —
   it is), push these files exactly as staged in
   `~/workspace/makefun/entries/pump-boothlord-repo/`, set the About
   website + topics.
2. Bundle transcripts (this session + parent session, one-letter
   structure), run `makefun check`, then submit signed by the user's
   agent wallet pin. Wallet signature stays with the user/pin flow.
3. Confirm the README badges render and `.makefun/owner.json` (59 bytes)
   is in the submitted commit.
