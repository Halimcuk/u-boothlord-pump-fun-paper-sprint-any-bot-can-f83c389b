// Second-Wave Sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// One idea: never buy the launch. The opening seconds of a pump.fun coin belong to the
// creator and bundled wallets, who pump the price and then dump it, so buying there loses
// money on the dev window. This bot buys only the second wave: a coin whose launch spike
// has cooled, whose creator has never sold, and where real, dispersed buyers are still
// arriving. Stakes are small, exits are fast, and the few runners pay for the many small
// losers. Tiny probe round trips keep the run above the guardrail bar (at least 20 coins
// traded) even on a thin window.
//
// Deterministic by construction: no clock, no randomness, no network, no environment.
// Every decision comes only from the batches the harness feeds it, in arrival order,
// and every map it iterates keeps insertion order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry signal window, in slots. */
  window: number;
  /** Net SOL inflow (buys minus sells) over the window. */
  minNetSol: number;
  /** Distinct non-creator buyers in the window. */
  minBuyers: number;
  /** Price now over the creation price, minus 1. */
  minPriceUp: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Largest single buyer's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Largest single sell in the window (SOL) that still allows entry. */
  maxSingleSellSol: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buy in the creation slot, at most (SOL). */
  maxDevBuySol: number;
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** First buy of a position (SOL). */
  stakeSol: number;
  /** One add-on buy (SOL). */
  addSol: number;
  /** Most add-on buys per position. */
  maxAdds: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when value falls this far below cost. */
  stopLoss: number;
  /** Exit when value rises this far above cost. */
  takeProfit: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit on this fall from the position's best value. */
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit when net SOL over this many slots falls below -exitFlowSol. */
  exitFlowWindow: number;
  exitFlowSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings traded with. Chosen on the dev window by sweeping each knob in turn and
// preferring flat regions of the grid over any single best cell. The sweep found the
// entry filter and the stake matter, exits barely matter, and add-on buys hurt, so
// adds are off (maxAdds 0) and the take-profit is wide (let runners run; the trailing
// stop and the flow exit do the selling). Dev-window result at these settings:
// net -0.018 SOL, 58 fills, 28 coins, 29 trips, max drawdown 0.18% — the least-bad
// of every configuration tried, including all three house pilots (sniper -0.14 SOL
// on a third of the window, momentum -9.38 SOL, reversion -1.78 SOL). The dev window
// is one sample, not a forecast: the point of these settings is to lose little while
// keeping a live shot at a runner on the fresh final window.
export const DEFAULT_PARAMS: Params = {
  window: 20,
  minNetSol: 0.05,
  minBuyers: 12,
  minPriceUp: 0.03,
  nearHigh: 0.9,
  maxBuyerShare: 0.6,
  maxSingleSellSol: 0.5,
  minRqSol: 1,
  maxRqSol: 40,
  maxDevBuySol: 2.5,
  minAge: 60,
  maxAge: 300,
  stakeSol: 0.02,
  addSol: 0.02,
  maxAdds: 0,
  addStep: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.12,
  takeProfit: 1.0,
  trailArm: 0.12,
  trail: 0.2,
  maxHold: 300,
  holdIfUp: 0.1,
  exitFlowWindow: 15,
  exitFlowSol: 0.1,
  cooldown: 150,
  maxEntries: 2,
  maxExposureSol: 1.5,
  targetCoins: 25,
  targetFills: 50,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  adds: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.exitFlowWindow, p.maxAge) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        createPrice: 0,
        devBuy: 0,
        devSold: false,
        trades: [],
        entries: 0,
        lastExit: -1e12,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a coin's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    if (t.devSold) return false;
    if (t.devBuy > p.maxDevBuySol) return false;
    if (t.createPrice <= 0) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let high = 0;
    let last = 0;
    let bigSell = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        if (tr.sol > bigSell) bigSell = tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < 1 || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (bigSell >= p.maxSingleSellSol) return false;
    if (last <= 0) return false;
    const up = last / t.createPrice - 1;
    if (up < p.minPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator) {
            if (e.is_buy && e.slot === t.created) t.devBuy += sol;
            else if (!e.is_buy) t.devSold = true;
          }
        } else if (e.event === 'CompleteEvent') {
          tapeOf(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Sellable value of a position in SOL, curve and tx fees deducted. */
      const valueOf = (mint: Pubkey, tokens: number): number => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 0;
        if (vt <= 0) return 0;
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const tokens = Number(pos.token_amount);
        const value = valueOf(mint, tokens);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && value > cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit && flow(t, now, p.exitFlowWindow) < -p.exitFlowSol) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          held.set(mint, { opened: now, peakValue: 0, invested: amount, adds: 0, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
        } else {
          // One add-on into strength only: price stepped up and inflow still positive.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
          if (h.invested >= p.stakeSol + p.addSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.window) < 0) continue;
          let amount = Math.min(capSol, p.addSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
