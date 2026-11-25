# Boothlord Momentum Paper Bot

![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/SRamadhan-07/makefun-pump-boothlord/rank.svg)
![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/SRamadhan-07/makefun-pump-boothlord/reward.svg)

A deterministic momentum bot for the make.fun competition
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
It paper-trades pump.fun bonding curves on a 6-hour replay under the
`agent-fun/replay/v2` harness (pumpfun-replay/v2): 10 SOL of paper capital,
at most 5 open positions, no shorts, no leverage.

## Strategy

- **Momentum with guardrails.** Enter only coins whose real SOL reserve is
  deep (at least 8 SOL) and growing, and whose recent flow is buyer-dominated
  (at least 66% of recent volume on the buy side). Thin or shrinking curves
  are skipped — that is where rugs live.
- **Small fixed clips.** 0.09 SOL for the strongest signals, 0.06 SOL
  standard, 0.04 SOL for breadth scouts, always capped by the harness rule of
  1% of the mint's real reserve per batch.
- **Mechanical exits.** Hard stop-loss at about −10%; take two thirds off
  near +25% and trail the remainder (exit on a 12% slide from the peak
  value); immediate full exit when the real reserve collapses to 55% of its
  peak (rug signal); time stops recycle flat or stale positions.
- **Drawdown brake.** New entries halt once portfolio drawdown from the
  equity peak reaches about 25%, well inside the 50% guardrail.
- **Breadth rotation.** Exited coins cool down for 30 slots, fresh coins win
  candidate ties, and smaller scout entries (reserve at least 5 SOL, flow not
  hostile) keep the distinct-coin count climbing so the minimum bar — a round
  trip of at least 0.01 SOL on each of at least 20 distinct coins — is
  cleared with margin.

## Determinism

The entry runs twice and the two action logs must match byte for byte. The
bot reads no clock, no environment and no randomness: every decision is a
pure function of the hello terms and the batch stream, with all money math
in bigint lamports and candidate ties broken by mint address.

## Layout

- `main.ts` — entrypoint: handshake, per-batch order planning, exits, brake.
- `strategy.ts` — per-mint flow bookkeeping, momentum/scout gates, curve
  valuation and scoring helpers.
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim for
  `agent-fun/replay/v2`, vendored unchanged as the kit prescribes.

## Run

The grader runs `node main.ts` on Node 22; the bot speaks newline-delimited
JSON on stdin/stdout (hello, batch, done in; one reply per batch out).
Diagnostics go to stderr only.

## License

MIT — see `LICENSE`.
