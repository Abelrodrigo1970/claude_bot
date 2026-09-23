/**
 * Lista 50 spike — filtro BTC (sobre a melhor gestão).
 *   SL 12% · TP 30%@+15% · resto 48h
 *
 * Compara baseline, SMA50↑ e várias variantes de regime BTC.
 *
 * Uso:
 *   node src/backtests/study-lista50-spike-btc-filter.js
 *   node src/backtests/study-lista50-spike-btc-filter.js 60
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL = 80;
const TAKER_FEE = 0.00055;
const TIMEFRAME = '15m';
const DAYS = parseInt(process.argv[2], 10) || 60;
const SPIKE_RATIO = 5;
const MA_PERIOD = 50;
const VOL_LOOKBACK = 10;
const MA_SLOPE_BARS = 10;
const HOLD_MS = 48 * 60 * 60 * 1000;
const SL_PCT = 0.12;
const TP_PCT = 0.15;
const TP_FRAC = 0.3;
const BTC_SYMBOL = 'BTC/USDT:USDT';

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map((m) => m.symbol);
const OUT = path.join(__dirname, 'out-lista50-spike-btc-filter.json');

function candlesNeeded15m() {
  return Math.round(DAYS * ((24 * 60) / 15)) + MA_PERIOD + VOL_LOOKBACK + 40;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

function toCandles(ohlcv) {
  return ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
    time: new Date(time),
    open,
    high,
    low,
    close,
    volume,
  }));
}

function spikeMeta(candles, i) {
  if (i < Math.max(MA_PERIOD + MA_SLOPE_BARS, VOL_LOOKBACK + 1) - 1) return null;
  const cur = candles[i];
  if (!(cur.close > cur.open)) return null;
  let volSum = 0;
  for (let j = i - VOL_LOOKBACK; j < i; j++) volSum += candles[j].volume;
  const avgVol = volSum / VOL_LOOKBACK;
  if (!(avgVol > 0)) return null;
  const ratio = cur.volume / avgVol;
  if (ratio < SPIKE_RATIO) return null;
  const closes = [];
  for (let j = i - MA_PERIOD + 1; j <= i; j++) closes.push(candles[j].close);
  const ma = sma(closes, MA_PERIOD);
  if (ma == null || !(cur.close > ma)) return null;

  const closesPrev = [];
  for (let j = i - MA_PERIOD - MA_SLOPE_BARS + 1; j <= i - MA_SLOPE_BARS; j++) {
    closesPrev.push(candles[j].close);
  }
  const maPrev = sma(closesPrev, MA_PERIOD);
  const maRising = maPrev != null && ma > maPrev;

  return {
    ratio,
    maRising,
    entryPrice: cur.close,
    entryTime: cur.time.getTime(),
  };
}

function closePart(fills, entryPrice, exitPrice, qty) {
  if (!(qty > 0)) return;
  const gross = (exitPrice - entryPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  fills.push(gross - fee);
}

function runTrade(candles, entryIdx, entryPrice, entryTime) {
  const fills = [];
  let qty = NOTIONAL / entryPrice;
  let remQty = qty;
  let tpDone = false;
  const deadline = entryTime + HOLD_MS;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const bar = candles[i];
    const t = bar.time.getTime();
    const slPrice = entryPrice * (1 - SL_PCT);
    if (bar.low <= slPrice) {
      closePart(fills, entryPrice, slPrice, remQty);
      remQty = 0;
      break;
    }
    if (!tpDone) {
      const tpPrice = entryPrice * (1 + TP_PCT);
      if (bar.high >= tpPrice) {
        const cq = qty * TP_FRAC;
        closePart(fills, entryPrice, tpPrice, cq);
        remQty -= cq;
        tpDone = true;
        if (remQty <= 1e-12) break;
      }
    }
    if (t >= deadline) {
      closePart(fills, entryPrice, bar.close, remQty);
      remQty = 0;
      break;
    }
  }
  if (remQty > 1e-12) {
    const last = candles[candles.length - 1];
    closePart(fills, entryPrice, last.close, remQty);
  }
  const pnl = fills.reduce((a, x) => a + x, 0);
  return { pnl, win: pnl > 0 };
}

/** Última vela com openTime <= t */
function findAtOrBefore(candles, t) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mt = candles[mid].time.getTime();
    if (mt <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function buildBtcRegime(btc15, btc4h, btc1d) {
  // Pré-computar EMA50 4h por barra
  const closes4h = btc4h.map((c) => c.close);
  const ema4hArr = EMA.calculate({ period: 50, values: closes4h });
  // EMA.calculate devolve array mais curto — alinhar ao fim
  const ema4hByIdx = new Array(btc4h.length).fill(null);
  const offset4h = btc4h.length - ema4hArr.length;
  for (let i = 0; i < ema4hArr.length; i++) ema4hByIdx[i + offset4h] = ema4hArr[i];

  // SMA50 15m
  const closes15 = btc15.map((c) => c.close);
  const sma15ByIdx = new Array(btc15.length).fill(null);
  for (let i = MA_PERIOD - 1; i < btc15.length; i++) {
    sma15ByIdx[i] = sma(closes15.slice(i - MA_PERIOD + 1, i + 1), MA_PERIOD);
  }

  return function regimeAt(entryTime) {
    const i15 = findAtOrBefore(btc15, entryTime);
    const i4h = findAtOrBefore(btc4h, entryTime);
    const i1d = findAtOrBefore(btc1d, entryTime);

    const c15 = i15 >= 0 ? btc15[i15] : null;
    const c4h = i4h >= 0 ? btc4h[i4h] : null;
    const c1d = i1d >= 0 ? btc1d[i1d] : null;
    const prev1d = i1d >= 1 ? btc1d[i1d - 1] : null;

    const ema4h = i4h >= 0 ? ema4hByIdx[i4h] : null;
    const sma15 = i15 >= 0 ? sma15ByIdx[i15] : null;

    const btcAboveEma4h = c4h != null && ema4h != null && c4h.close > ema4h;
    const btcAboveSma15 = c15 != null && sma15 != null && c15.close > sma15;
    const btc4hGreen = c4h != null && c4h.close > c4h.open;
    const btcDailyUp = c1d != null && prev1d != null && c1d.close >= prev1d.close;
    const btc15Green = c15 != null && c15.close > c15.open;

    // SMA15 slope BTC
    let btcSma15Rising = false;
    if (i15 >= MA_PERIOD + MA_SLOPE_BARS - 1) {
      const maNow = sma15ByIdx[i15];
      const maPrev = sma15ByIdx[i15 - MA_SLOPE_BARS];
      btcSma15Rising = maNow != null && maPrev != null && maNow > maPrev;
    }

    return {
      btcAboveEma4h,
      btcAboveSma15,
      btc4hGreen,
      btcDailyUp,
      btc15Green,
      btcSma15Rising,
    };
  };
}

function collectSignals(data, btcAt) {
  const signals = [];
  for (const [ticker, candles] of Object.entries(data)) {
    const lastT = candles[candles.length - 1].time.getTime();
    const cutoff = lastT - DAYS * 24 * 3600 * 1000;
    let busyUntil = 0;
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i].time.getTime();
      if (t < cutoff) continue;
      if (t < busyUntil) continue;
      const meta = spikeMeta(candles, i);
      if (!meta) continue;
      const trade = runTrade(candles, i, meta.entryPrice, meta.entryTime);
      const btc = btcAt(meta.entryTime);
      busyUntil = t + HOLD_MS;
      signals.push({ ticker, ...meta, ...trade, ...btc });
    }
  }
  return signals;
}

function summarize(trades) {
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades.slice().sort((a, b) => a.entryTime - b.entryTime)) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    wr: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnl: totalPnl,
    pf,
    maxDD,
    avgPnl: trades.length ? totalPnl / trades.length : 0,
  };
}

const FILTERS = [
  { id: 'baseline', label: 'Baseline (spike≥5× + verde + >SMA50)', fn: () => true },
  { id: 'smaUp', label: 'SMA50↑ (estratégia atual)', fn: (s) => s.maRising },
  { id: 'btcEma4h', label: 'BTC > EMA50 4h', fn: (s) => s.btcAboveEma4h },
  { id: 'btcSma15', label: 'BTC > SMA50 15m', fn: (s) => s.btcAboveSma15 },
  { id: 'btcDailyUp', label: 'BTC diário a subir', fn: (s) => s.btcDailyUp },
  { id: 'btc4hGreen', label: 'BTC 4h verde', fn: (s) => s.btc4hGreen },
  { id: 'btc15Green', label: 'BTC 15m verde', fn: (s) => s.btc15Green },
  { id: 'btcSma15Up', label: 'BTC SMA50 15m↑', fn: (s) => s.btcSma15Rising },
  {
    id: 'smaUp_btcEma4h',
    label: 'SMA50↑ + BTC > EMA50 4h',
    fn: (s) => s.maRising && s.btcAboveEma4h,
  },
  {
    id: 'smaUp_btcSma15',
    label: 'SMA50↑ + BTC > SMA50 15m',
    fn: (s) => s.maRising && s.btcAboveSma15,
  },
  {
    id: 'smaUp_btcDaily',
    label: 'SMA50↑ + BTC diário↑',
    fn: (s) => s.maRising && s.btcDailyUp,
  },
  {
    id: 'smaUp_btc4hGreen',
    label: 'SMA50↑ + BTC 4h verde',
    fn: (s) => s.maRising && s.btc4hGreen,
  },
  {
    id: 'smaUp_btcEma4h_daily',
    label: 'SMA50↑ + BTC>EMA4h + diário↑',
    fn: (s) => s.maRising && s.btcAboveEma4h && s.btcDailyUp,
  },
];

async function fetchUniverse(exchange) {
  const total = candlesNeeded15m();
  const out = {};
  for (const symbol of SYMBOLS) {
    const ticker = symbol.split('/')[0];
    try {
      if (!exchange.markets[symbol]) continue;
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total);
      const candles = toCandles(ohlcv);
      if (candles.length < MA_PERIOD + VOL_LOOKBACK + 20) continue;
      out[ticker] = candles;
      process.stdout.write('.');
    } catch {
      process.stdout.write('x');
    }
  }
  console.log(`\n[${TIMEFRAME}] ${Object.keys(out).length} símbolos`);
  return out;
}

async function fetchBtc(exchange) {
  const n15 = candlesNeeded15m();
  const n4h = Math.round(DAYS * 6) + 80;
  const n1d = DAYS + 10;
  console.log('A obter BTC 15m / 4h / 1d...');
  const [o15, o4h, o1d] = await Promise.all([
    fetchOHLCVPaginated(exchange, BTC_SYMBOL, '15m', n15),
    fetchOHLCVPaginated(exchange, BTC_SYMBOL, '4h', n4h),
    fetchOHLCVPaginated(exchange, BTC_SYMBOL, '1d', n1d),
  ]);
  return {
    btc15: toCandles(o15),
    btc4h: toCandles(o4h),
    btc1d: toCandles(o1d),
  };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados...');
  await exchange.loadMarkets();
  console.log(`BTC filter · Lista 50 spike · ${DAYS}d · SL12 · 30%@15% · 48h`);

  const [{ btc15, btc4h, btc1d }, data] = await Promise.all([
    fetchBtc(exchange),
    fetchUniverse(exchange),
  ]);
  console.log(`BTC bars: 15m=${btc15.length} 4h=${btc4h.length} 1d=${btc1d.length}`);

  const btcAt = buildBtcRegime(btc15, btc4h, btc1d);
  const all = collectSignals(data, btcAt);
  console.log(`Sinais baseline: ${all.length}`);

  const base = summarize(all);
  const rows = FILTERS.map((f) => {
    const filtered = all.filter(f.fn);
    const s = summarize(filtered);
    return {
      id: f.id,
      label: f.label,
      ...s,
      pnlDelta: s.pnl - base.pnl,
      lossCut: base.losses - s.losses,
      tradeCut: base.n - s.n,
      wrDelta: s.wr - base.wr,
    };
  }).sort((a, b) => b.pnl - a.pnl || a.losses - b.losses);

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    config: { slPct: SL_PCT, tpPct: TP_PCT, tpFrac: TP_FRAC, holdH: 48, notional: NOTIONAL },
    baseline: {
      ...base,
      wr: Number(base.wr.toFixed(1)),
      pnl: Number(base.pnl.toFixed(2)),
      pf: Number(base.pf.toFixed(2)),
      maxDD: Number(base.maxDD.toFixed(2)),
    },
    results: rows.map((r) => ({
      ...r,
      wr: Number(r.wr.toFixed(1)),
      pnl: Number(r.pnl.toFixed(2)),
      pf: r.pf === Infinity ? null : Number(r.pf.toFixed(2)),
      maxDD: Number(r.maxDD.toFixed(2)),
      avgPnl: Number(r.avgPnl.toFixed(2)),
      pnlDelta: Number(r.pnlDelta.toFixed(2)),
      wrDelta: Number(r.wrDelta.toFixed(1)),
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Filtro BTC · ${DAYS}d (ordenado por PnL)`);
  console.log('════════════════════════════════════════════════════════');
  console.table(
    rows.map((r) => ({
      filtro: r.label,
      n: r.n,
      losses: r.losses,
      lossCut: r.lossCut,
      wr: r.wr.toFixed(1) + '%',
      pnl: (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(0),
      dPnl: (r.pnlDelta >= 0 ? '+' : '') + r.pnlDelta.toFixed(0),
      pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
      maxDD: r.maxDD.toFixed(0),
      avg: r.avgPnl.toFixed(2),
    }))
  );
  console.log(`JSON → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
