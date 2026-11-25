// Boothlord Momentum Paper Bot — a pump.fun paper-trading entry for
// agent-fun/replay/v2 (harness pumpfun-replay/v2, Node 22, main.ts entrypoint).
//
// Wire contract, briefly: the harness sends one hello line, then one batch
// line per slot, then a done line. For every batch the bot answers with
// exactly one reply carrying that batch's seq and the orders decided on that
// slot. Orders fill two slots later. The bot is executed twice and the two
// action logs must match byte for byte, so this file is fully deterministic:
// no clock reads, no environment reads, no randomness — decisions depend only
// on the hello terms and the batch stream itself.
//
// Strategy (see strategy.ts for the scoring helpers):
//   * Enter coins whose real SOL reserve is deep (>= 8 SOL) and growing and
//     whose recent flow is buyer-dominated. Thin or shrinking curves are
//     ignored: they are where rugs live.
//   * Clips are small and fixed by conviction: 0.09 SOL for the strongest
//     signals, 0.06 SOL standard, 0.04 SOL for breadth scouts.
//   * Exits are mechanical: hard stop at -10%, sell two thirds at +25% and
//     trail the rest, instant full exit when the real reserve collapses to
//     55% of its peak (rug signal), plus time stops that recycle capital.
//   * A portfolio brake halts new entries once drawdown from the equity peak
//     reaches 25%, well inside the 50% guardrail.
//   * Rotation: exited coins cool down, fresh coins win candidate ties, and
//     scout entries keep the distinct-coin count climbing past twenty.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';
import {
  curveValueLamports,
  momentumScore,
  newMintBook,
  observeTrade,
  passesMomentumGate,
  passesScoutGate,
  valueAtLeast,
  valueAtMost,
  type MintBook,
} from './strategy.ts';

// ---- tuning constants (lamports unless noted) ----

const DEEP_RESERVE = 8n * LAMPORTS_PER_SOL; // strict entries need this much real SOL
const SCOUT_RESERVE = 5n * LAMPORTS_PER_SOL; // scouts accept a shallower curve
const CLIP_STRONG = (LAMPORTS_PER_SOL * 9n) / 100n; // 0.09 SOL
const CLIP_BASE = (LAMPORTS_PER_SOL * 6n) / 100n; // 0.06 SOL
const CLIP_SCOUT = (LAMPORTS_PER_SOL * 4n) / 100n; // 0.04 SOL
const MIN_CLIP = LAMPORTS_PER_SOL / 50n; // never send a buy under 0.02 SOL
const STRONG_SCORE = 420; // momentumScore at or above this earns the big clip
const MAX_ENTRIES_PER_MINT = 3;
const COOLDOWN_SLOTS = 30; // slots to wait after a full exit before re-entry
const STALE_SLOTS = 900; // a held coin with no trade this long is abandoned
const ROTATE_SLOTS = 900; // flat positions older than this are recycled
const MAX_HOLD_SLOTS = 2400; // nothing is held longer than this
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1500; // exits prefer filling over squeezing price

// ---- run state ----

const books = new Map<string, MintBook>();
/** Mints whose buy is believed open: entry slot and entry reserve peak base. */
const heldSince = new Map<string, { slot: number; tookPartial: boolean; peakValue: bigint; peakReserve: bigint }>();
/** Mints with a sell already in flight, so exits are never doubled. */
const sellPending = new Set<string>();
let roundTripsDone = 0;
let peakEquity = 0n;
let entriesHalted = false;

function bookFor(mint: string, slot: number): MintBook {
  let b = books.get(mint);
  if (b === undefined) {
    b = newMintBook(mint, slot);
    books.set(mint, b);
  }
  return b;
}

/** SOL value of everything: cash plus each position marked to its curve. */
function equityOf(state: BotState): bigint {
  let total = state.cash;
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    total += curveValueLamports(curve.virtual_quote_reserves, curve.virtual_token_reserves, pos.token_amount);
  }
  return total;
}

/** Forget run-state for positions that vanished (fills, completes, flatten). */
function syncHeld(state: BotState, slot: number): void {
  for (const mint of [...heldSince.keys()]) {
    if (!state.positions.has(mint)) {
      heldSince.delete(mint);
      sellPending.delete(mint);
      const b = books.get(mint);
      if (b !== undefined && b.lastExitSlot < 0) {
        b.lastExitSlot = slot;
        if (!b.roundTripped) {
          b.roundTripped = true;
          roundTripsDone += 1;
        }
      }
    }
  }
  for (const mint of state.positions.keys()) {
    if (!heldSince.has(mint)) {
      const curve = state.curves.get(mint);
      heldSince.set(mint, {
        slot,
        tookPartial: false,
        peakValue: 0n,
        peakReserve: curve?.real_quote_reserves ?? 0n,
      });
    }
  }
}

/** Decide every exit for currently held positions. Sells come first. */
function planExits(state: BotState, slot: number, budget: number): SellInput[] {
  const sells: SellInput[] = [];
  for (const [mint, pos] of state.positions) {
    if (sells.length >= budget) break;
    if (sellPending.has(mint)) continue;
    const curve = state.curves.get(mint);
    const held = heldSince.get(mint);
    if (curve === undefined || held === undefined) continue;
    if (curve.complete) continue; // the harness closes completed curves itself

    const value = curveValueLamports(curve.virtual_quote_reserves, curve.virtual_token_reserves, pos.token_amount);
    if (value > held.peakValue) held.peakValue = value;
    if (curve.real_quote_reserves > held.peakReserve) held.peakReserve = curve.real_quote_reserves;
    const book = books.get(mint);
    const age = slot - held.slot;
    const quiet = book !== undefined && slot - book.lastTradeSlot > STALE_SLOTS;

    let sellTokens: bigint | null = null;

    // Rug signal: the real reserve has collapsed far below its peak.
    if (held.peakReserve > 0n && curve.real_quote_reserves * 100n <= held.peakReserve * 55n) {
      sellTokens = pos.token_amount;
    }
    // Hard stop-loss around -10%.
    if (sellTokens === null && valueAtMost(value, pos.cost_lamports, 90n, 100n)) {
      sellTokens = pos.token_amount;
    }
    // Take two thirds off near +25%, once.
    if (sellTokens === null && !held.tookPartial && valueAtLeast(value, pos.cost_lamports, 125n, 100n)) {
      sellTokens = (pos.token_amount * 2n) / 3n;
      held.tookPartial = true;
    }
    // Trail the remainder: after banking the partial, a 12% slide from the
    // best value seen closes what is left.
    if (sellTokens === null && held.tookPartial && held.peakValue > 0n && value * 100n <= held.peakValue * 88n) {
      sellTokens = pos.token_amount;
    }
    // Rotation and staleness: recycle flat or dead positions into fresh coins.
    if (sellTokens === null && quiet) sellTokens = pos.token_amount;
    if (sellTokens === null && age > ROTATE_SLOTS && valueAtMost(value, pos.cost_lamports, 105n, 100n)) {
      sellTokens = pos.token_amount;
    }
    if (sellTokens === null && age > MAX_HOLD_SLOTS) sellTokens = pos.token_amount;

    if (sellTokens !== null && sellTokens > 0n) {
      sells.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      sellPending.add(mint);
    }
  }
  return sells;
}

/** Decide new entries for this batch, strict momentum first, scouts second. */
function planEntries(state: BotState, slot: number, budget: number): BuyInput[] {
  const { caps } = state.hello;
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports();
  let openSlots = caps.max_open_positions - state.committedPositionCount();
  const buys: BuyInput[] = [];
  if (entriesHalted || openSlots <= 0 || budget <= 0) return buys;

  interface Candidate {
    mint: string;
    score: number;
    scout: boolean;
  }
  const strict: Candidate[] = [];
  const scouts: Candidate[] = [];
  for (const [mint, book] of books) {
    if (buys.length + strict.length + scouts.length > 64) break;
    if (state.positions.has(mint)) continue;
    if (book.entries >= MAX_ENTRIES_PER_MINT) continue;
    if (book.lastExitSlot >= 0 && slot - book.lastExitSlot < COOLDOWN_SLOTS) continue;
    if (slot - book.lastTradeSlot > 60) continue; // only trade what is trading now
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    let hasPendingBuy = false;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) hasPendingBuy = true;
    }
    if (hasPendingBuy) continue;
    if (passesMomentumGate(book, DEEP_RESERVE, curve.real_quote_reserves, 250)) {
      strict.push({ mint, score: momentumScore(book), scout: false });
    } else if (roundTripsDone + state.positions.size < 24 && passesScoutGate(book, SCOUT_RESERVE, curve.real_quote_reserves)) {
      scouts.push({ mint, score: momentumScore(book), scout: true });
    }
  }
  const byScoreThenMint = (a: Candidate, b: Candidate): number => {
    if (b.score !== a.score) return b.score - a.score;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  };
  strict.sort(byScoreThenMint);
  scouts.sort(byScoreThenMint);

  for (const cand of [...strict, ...scouts]) {
    if (buys.length >= budget || openSlots <= 0) break;
    const cap = state.maxBuyLamports(cand.mint);
    let clip = cand.scout ? CLIP_SCOUT : cand.score >= STRONG_SCORE ? CLIP_STRONG : CLIP_BASE;
    if (cap < clip) clip = cap;
    if (clip < MIN_CLIP) continue;
    if (free < clip + tx) continue;
    buys.push({ side: 'buy', mint: cand.mint, quote_lamports: clip, max_slippage_bps: BUY_SLIPPAGE_BPS });
    free -= clip + tx;
    openSlots -= 1;
    const book = books.get(cand.mint);
    if (book !== undefined) book.entries += 1;
  }
  return buys;
}

await runBot({
  onHello(state) {
    peakEquity = BigInt(state.hello.capital.lamports);
    console.error(`hello: capital ${state.hello.capital.lamports} lamports, caps ${state.hello.caps.max_open_positions} positions`);
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;

    // Learn from this batch's fills first: a filled sell clears the pending
    // flag, and a position that closed out starts its cooldown here.
    for (const fill of batch.fills) {
      // Any resolved sell — filled, rejected or failed — frees the mint for a
      // fresh exit decision on a later batch.
      if (fill.side === 'sell') sellPending.delete(fill.mint);
    }

    // Fold every trade of this batch into the per-mint books.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const book = bookFor(e.mint, slot);
        observeTrade(book, slot, e.is_buy, BigInt(e.quote_amount), BigInt(e.real_quote_reserves));
      } else if (e.event === 'CreateEvent') {
        bookFor(e.mint, slot);
      }
    }

    syncHeld(state, slot);

    // Drawdown brake: mark equity to market, remember the peak, and stop
    // opening new risk once the fall from the peak reaches about 25%.
    const equity = equityOf(state);
    if (equity > peakEquity) peakEquity = equity;
    entriesHalted = peakEquity > 0n && equity * 100n <= peakEquity * 75n;

    const maxOrders = state.hello.caps.max_orders_per_batch;
    const sells = planExits(state, slot, maxOrders);
    const buys = planEntries(state, slot, maxOrders - sells.length);
    const orders: OrderInput[] = [...sells, ...buys];
    return orders;
  },

  onDone(state) {
    console.error(`done: cash ${state.cash} lamports, round trips on ${roundTripsDone} coins`);
  },
});
