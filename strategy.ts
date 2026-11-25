// strategy.ts — Boothlord Momentum Paper Bot: signal bookkeeping and decision helpers.
//
// This module is pure bookkeeping plus arithmetic. It never reads the clock,
// never touches the network or the filesystem, and never uses randomness, so
// the same hello and the same stream of batch events always produce the same
// orders. Time inside the replay means one thing only: the slot carried by
// each batch. All money math is bigint lamports; ratios are compared by
// cross-multiplication so no floating point ever sneaks into a decision.
//
// The trading idea, in one paragraph: follow coins whose real SOL reserve is
// deep and still growing while recent flow is dominated by buyers, buy them in
// small fixed clips, and leave quickly when the story breaks — a hard stop, a
// reserve collapse (the classic rug signature), or a take-profit that banks
// two thirds and trails the rest. A rotation rule keeps cycling capital into
// fresh coins so the bot clears the twenty-coin round-trip bar with margin.

/** One observed trade, reduced to what the momentum score needs. */
export interface FlowTick {
  slot: number;
  isBuy: boolean;
  quoteLamports: bigint;
  realQuoteReserves: bigint;
}

/** Everything remembered about one mint across the whole run. */
export interface MintBook {
  mint: string;
  firstSeenSlot: number;
  lastTradeSlot: number;
  /** Recent trades, oldest first, capped at FLOW_WINDOW entries. */
  flow: FlowTick[];
  /** Real SOL reserve sampled at each trade, oldest first, capped. */
  reserveTrail: bigint[];
  /** Highest real SOL reserve ever observed on this mint. */
  reservePeak: bigint;
  /** How many times the bot has opened a position in this mint. */
  entries: number;
  /** Slot of the last full exit, or -1 while never exited. */
  lastExitSlot: number;
  /** True once a buy followed by a full sell has completed on this mint. */
  roundTripped: boolean;
}

const FLOW_WINDOW = 24;

export function newMintBook(mint: string, slot: number): MintBook {
  return {
    mint,
    firstSeenSlot: slot,
    lastTradeSlot: slot,
    flow: [],
    reserveTrail: [],
    reservePeak: 0n,
    entries: 0,
    lastExitSlot: -1,
    roundTripped: false,
  };
}

/** Fold one trade event into the book. Call once per TradeEvent, in order. */
export function observeTrade(
  book: MintBook,
  slot: number,
  isBuy: boolean,
  quoteLamports: bigint,
  realQuoteReserves: bigint,
): void {
  book.lastTradeSlot = slot;
  book.flow.push({ slot, isBuy, quoteLamports, realQuoteReserves });
  if (book.flow.length > FLOW_WINDOW) book.flow.shift();
  book.reserveTrail.push(realQuoteReserves);
  if (book.reserveTrail.length > FLOW_WINDOW) book.reserveTrail.shift();
  if (realQuoteReserves > book.reservePeak) book.reservePeak = realQuoteReserves;
}

/** Buyer share of recent flow volume, as a percentage 0..100 (integer math). */
export function buyVolumeSharePct(book: MintBook): number {
  let buy = 0n;
  let sell = 0n;
  for (const t of book.flow) {
    if (t.isBuy) buy += t.quoteLamports;
    else sell += t.quoteLamports;
  }
  const total = buy + sell;
  if (total === 0n) return 0;
  return Number((buy * 100n) / total);
}

/** Count of buy trades minus sell trades over the recent flow window. */
export function buyCountEdge(book: MintBook): number {
  let edge = 0;
  for (const t of book.flow) edge += t.isBuy ? 1 : -1;
  return edge;
}

/**
 * Reserve growth over the observed trail, in basis points: latest reserve
 * versus the oldest sample still in the window. Negative when shrinking.
 * Returns 0 when there is not enough history to say anything.
 */
export function reserveGrowthBps(book: MintBook): number {
  if (book.reserveTrail.length < 6) return 0;
  const oldest = book.reserveTrail[0];
  const latest = book.reserveTrail[book.reserveTrail.length - 1];
  if (oldest === undefined || latest === undefined || oldest <= 0n) return 0;
  const diff = latest - oldest;
  return Number((diff * 10_000n) / oldest);
}

/**
 * Estimated SOL value of selling `tokens` into a bonding curve with the given
 * virtual reserves, under the constant-product rule the curve follows:
 * out = virtualQuote * tokens / (virtualToken + tokens). Fees are ignored
 * here; this is a decision gauge, not an accounting figure.
 */
export function curveValueLamports(
  virtualQuoteReserves: bigint,
  virtualTokenReserves: bigint,
  tokens: bigint,
): bigint {
  if (tokens <= 0n) return 0n;
  const denom = virtualTokenReserves + tokens;
  if (denom <= 0n) return 0n;
  return (virtualQuoteReserves * tokens) / denom;
}

/** True when value is at or above cost * num / den (e.g. 125/100 for +25%). */
export function valueAtLeast(value: bigint, cost: bigint, num: bigint, den: bigint): boolean {
  if (cost <= 0n) return false;
  return value * den >= cost * num;
}

/** True when value is at or below cost * num / den (e.g. 90/100 for -10%). */
export function valueAtMost(value: bigint, cost: bigint, num: bigint, den: bigint): boolean {
  if (cost <= 0n) return false;
  return value * den <= cost * num;
}

/**
 * Momentum score for ranking entry candidates against each other. Higher is
 * stronger. Built only from integers so ties break identically on every run;
 * the caller breaks remaining ties by mint string.
 */
export function momentumScore(book: MintBook): number {
  const growth = reserveGrowthBps(book);
  const share = buyVolumeSharePct(book);
  const edge = buyCountEdge(book);
  let score = 0;
  score += Math.min(Math.max(growth, -2000), 4000) / 10;
  score += (share - 50) * 4;
  score += edge * 15;
  score += Math.min(book.flow.length, FLOW_WINDOW) * 2;
  if (!book.roundTripped) score += 120; // breadth first: fresh coins win ties
  return score;
}

/**
 * The strict momentum gate. A coin may be bought only when its reserve is
 * deep, its reserve is growing, and its recent flow is buyer-dominated.
 * `minReserve` and the growth floor are parameters so the caller can relax
 * them slightly for small scout entries late in the breadth hunt.
 */
export function passesMomentumGate(
  book: MintBook,
  minReserveLamports: bigint,
  latestRealReserve: bigint,
  minGrowthBps: number,
): boolean {
  if (book.flow.length < 8) return false;
  if (latestRealReserve < minReserveLamports) return false;
  const growth = reserveGrowthBps(book);
  if (growth < minGrowthBps) return false;
  if (growth > 15000) return false; // blow-off top: +150% inside one window is a trap, not momentum
  if (buyVolumeSharePct(book) < 66) return false;
  if (buyCountEdge(book) < 2) return false;
  return true;
}

/**
 * Looser scout gate used only to widen breadth when no strict candidate is
 * available: still demands a real reserve floor and non-hostile flow, but
 * accepts flat reserves. Scout clips are smaller (the caller sizes them).
 */
export function passesScoutGate(
  book: MintBook,
  minReserveLamports: bigint,
  latestRealReserve: bigint,
): boolean {
  if (book.flow.length < 6) return false;
  if (latestRealReserve < minReserveLamports) return false;
  if (reserveGrowthBps(book) < -300) return false; // never catch a falling knife
  if (buyVolumeSharePct(book) < 58) return false; // a coin flip bleeds fees; demand a real edge
  if (buyCountEdge(book) < 1) return false;
  return true;
}
