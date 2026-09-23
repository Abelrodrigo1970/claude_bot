/**
 * Sweep de filtros de entrada na melhor combo Lista 50 spike
 *   SL 12% · TP 30%@+15% · resto 48h
 *
 * Uso:
 *   node src/backtests/study-lista50-spike-entry-filters.js
 *   node src/backtests/study-lista50-spike-entry-filters.js 60
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL = 80;
const TAKER_FEE = 0.00055;
const TIMEFRAME = '15m';
const DAYS = parseInt(process.argv[2], 10) || 60;
const SPIKE_RATIO = 5;
const MA_PERIOD = 50;
const VOL_LOOKBACK = 10;
const HOLD_MS = 48 * 60 * 60 * 1000;
const SL_PCT = 0.12;
const TP_PCT = 0.15;
const TP_FRAC = 0.3;

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map((m) => m.symbol);
const OUT = path.join(__dirname, 'out-lista50-spike-entry-filters.json');

function candlesNeeded() {
  return Math.round(DAYS * ((24 * 60) / 15)) + MA_PERIOD + VOL_LOOKBACK + 40;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const ag = gains / period;
  const al = losses / period;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

function spikeMeta(candles, i) {
  if (i < Math.max(MA_PERIOD, VOL_LOOKBACK + 1, 15) - 1) return null;
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

  const bodyPct = ((cur.close - cur.open) / cur.open) * 100;
  const rangePct = ((cur.high - cur.low) / cur.open) * 100;
  const aboveMaPct = ((cur.close - ma) / ma) * 100;
  const closeLoc =
    cur.high > cur.low ? (cur.close - cur.low) / (cur.high - cur.low) : 1;
  const rsiCloses = [];
  for (let j = i - 20; j <= i; j++) rsiCloses.push(candles[j].close);
  const rsi14 = rsi(rsiCloses, 14);
  const prev = candles[i - 1];
  const prevGreen = prev.close > prev.open;
  const hourUtc = new Date(cur.time.getTime()).getUTCHours();

  // trend: SMA50 slope (vs 10 bars ago)
  const closesOlder = [];
  for (let j = i - MA_PERIOD - 9; j <= i - 10; j++) closesOlder.push(candles[j].close);
  const maPrev = sma(closesOlder, MA_PERIOD);
  const maSlopePct = maPrev ? ((ma - maPrev) / maPrev) * 100 : 0;

  return {
    ratio,
    bodyPct,
    rangePct,
    aboveMaPct,
    closeLoc,
    rsi14,
    prevGreen,
    hourUtc,
    maSlopePct,
    entryPrice: cur.close,
    entryTime: cur.time.getTime(),
  };
}

function closePart(fills, pos, exitPrice, exitTime, qty, tag) {
  if (!(qty > 0)) return;
  const gross = (exitPrice - pos.entryPrice) * qty;
  const fee = (pos.entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  fills.push({ pnl: gross - fee, tag });
}

function runTrade(candles, entryIdx, meta) {
  const fills = [];
  const entryPrice = meta.entryPrice;
  const entryTime = meta.entryTime;
  let qty = NOTIONAL / entryPrice;
  let remQty = qty;
  let tpDone = false;
  const deadline = entryTime + HOLD_MS;
  let mfe1h = 0;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const bar = candles[i];
    const t = bar.time.getTime();
    const hours = (t - entryTime) / 3600000;
    const mfePct = ((bar.high - entryPrice) / entryPrice) * 100;
    if (hours <= 1) mfe1h = Math.max(mfe1h, mfePct);

    const slPrice = entryPrice * (1 - SL_PCT);
    if (bar.low <= slPrice) {
      closePart(fills, { entryPrice }, slPrice, t, remQty, 'sl');
      remQty = 0;
      break;
    }
    if (!tpDone) {
      const tpPrice = entryPrice * (1 + TP_PCT);
      if (bar.high >= tpPrice) {
        const cq = qty * TP_FRAC;
        closePart(fills, { entryPrice }, tpPrice, t, cq, 'tp');
        remQty -= cq;
        tpDone = true;
        if (remQty <= 1e-12) break;
      }
    }
    if (t >= deadline) {
      closePart(fills, { entryPrice }, bar.close, t, remQty, 'time48h');
      remQty = 0;
      break;
    }
  }
  if (remQty > 1e-12) {
    const last = candles[candles.length - 1];
    closePart(fills, { entryPrice }, last.close, last.time.getTime(), remQty, 'open');
  }
  const pnl = fills.reduce((a, f) => a + f.pnl, 0);
  return { pnl, win: pnl > 0, mfe1h, tags: fills.map((f) => f.tag) };
}

function collectSignals(data) {
  const cutoffByTicker = {};
  const signals = [];
  for (const [ticker, candles] of Object.entries(data)) {
    const lastT = candles[candles.length - 1].time.getTime();
    const cutoff = lastT - DAYS * 24 * 3600 * 1000;
    cutoffByTicker[ticker] = cutoff;
    let busyUntil = 0;
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i].time.getTime();
      if (t < cutoff) continue;
      if (t < busyUntil) continue;
      const meta = spikeMeta(candles, i);
      if (!meta) continue;
      const trade = runTrade(candles, i, meta);
      // occupy until exit roughly 48h (simple: block new entries while in trade window)
      busyUntil = t + HOLD_MS;
      signals.push({ ticker, idx: i, ...meta, ...trade });
    }
  }
  return signals;
}

const FILTERS = [
  { id: 'baseline', label: 'Baseline (spike≥5× + verde + >SMA50)', fn: () => true },
  { id: 'spike8', label: 'Spike ≥8×', fn: (s) => s.ratio >= 8 },
  { id: 'spike10', label: 'Spike ≥10×', fn: (s) => s.ratio >= 10 },
  { id: 'spike12', label: 'Spike ≥12×', fn: (s) => s.ratio >= 12 },
  { id: 'body2', label: 'Body ≥2%', fn: (s) => s.bodyPct >= 2 },
  { id: 'body3', label: 'Body ≥3%', fn: (s) => s.bodyPct >= 3 },
  { id: 'body4', label: 'Body ≥4%', fn: (s) => s.bodyPct >= 4 },
  { id: 'aboveMa3', label: 'Close ≥3% acima SMA50', fn: (s) => s.aboveMaPct >= 3 },
  { id: 'aboveMa5', label: 'Close ≥5% acima SMA50', fn: (s) => s.aboveMaPct >= 5 },
  { id: 'closeLoc70', label: 'Close no top 30% da vela', fn: (s) => s.closeLoc >= 0.7 },
  { id: 'closeLoc85', label: 'Close no top 15% da vela', fn: (s) => s.closeLoc >= 0.85 },
  { id: 'rsi55', label: 'RSI14 ≥55', fn: (s) => s.rsi14 != null && s.rsi14 >= 55 },
  { id: 'rsi60', label: 'RSI14 ≥60', fn: (s) => s.rsi14 != null && s.rsi14 >= 60 },
  { id: 'maUp', label: 'SMA50 a subir (10 barras)', fn: (s) => s.maSlopePct > 0 },
  { id: 'prevGreen', label: 'Vela anterior verde', fn: (s) => s.prevGreen },
  { id: 'noNight', label: 'Evitar 22–02 UTC', fn: (s) => !(s.hourUtc >= 22 || s.hourUtc <= 2) },
  {
    id: 'body2_close70',
    label: 'Body≥2% + close top30%',
    fn: (s) => s.bodyPct >= 2 && s.closeLoc >= 0.7,
  },
  {
    id: 'body2_rsi55',
    label: 'Body≥2% + RSI≥55',
    fn: (s) => s.bodyPct >= 2 && s.rsi14 != null && s.rsi14 >= 55,
  },
  {
    id: 'spike8_body2',
    label: 'Spike≥8× + body≥2%',
    fn: (s) => s.ratio >= 8 && s.bodyPct >= 2,
  },
  {
    id: 'spike8_close70',
    label: 'Spike≥8× + close top30%',
    fn: (s) => s.ratio >= 8 && s.closeLoc >= 0.7,
  },
  {
    id: 'body2_maUp',
    label: 'Body≥2% + SMA50 a subir',
    fn: (s) => s.bodyPct >= 2 && s.maSlopePct > 0,
  },
  {
    id: 'body2_close70_maUp',
    label: 'Body≥2% + top30% + SMA↑',
    fn: (s) => s.bodyPct >= 2 && s.closeLoc >= 0.7 && s.maSlopePct > 0,
  },
  {
    id: 'quality',
    label: 'Quality: body≥2% + top30% + RSI≥55',
    fn: (s) => s.bodyPct >= 2 && s.closeLoc >= 0.7 && s.rsi14 != null && s.rsi14 >= 55,
  },
  {
    id: 'quality_ma',
    label: 'Quality + SMA↑',
    fn: (s) =>
      s.bodyPct >= 2 && s.closeLoc >= 0.7 && s.rsi14 != null && s.rsi14 >= 55 && s.maSlopePct > 0,
  },
];

function summarize(signals) {
  const closed = signals.filter((s) => !s.tags.includes('open') || s.tags.length > 1);
  // count all as trades (including still-open marked)
  const trades = signals;
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const slN = trades.filter((t) => t.tags.includes('sl')).length;
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    wr: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnl: totalPnl,
    pf,
    slN,
    avgPnl: trades.length ? totalPnl / trades.length : 0,
  };
}

async function fetchUniverse(exchange) {
  const total = candlesNeeded();
  const out = {};
  for (const symbol of SYMBOLS) {
    const ticker = symbol.split('/')[0];
    try {
      if (!exchange.markets[symbol]) continue;
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total);
      const candles = ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
        time: new Date(time),
        open,
        high,
        low,
        close,
        volume,
      }));
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

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados...');
  await exchange.loadMarkets();
  console.log(`Filtros · Lista 50 spike · ${DAYS}d · SL12 · 30%@15% · 48h`);
  const data = await fetchUniverse(exchange);
  const all = collectSignals(data);
  console.log(`Sinais baseline gerados: ${all.length}`);

  const base = summarize(all);
  const rows = [];
  for (const f of FILTERS) {
    const filtered = all.filter(f.fn);
    const s = summarize(filtered);
    rows.push({
      id: f.id,
      label: f.label,
      ...s,
      pnlDelta: s.pnl - base.pnl,
      lossCut: base.losses - s.losses,
      tradeCut: base.n - s.n,
      wrDelta: s.wr - base.wr,
    });
  }

  // rank: prefer higher pnl, then fewer losses, then higher WR
  const ranked = rows
    .slice()
    .sort((a, b) => b.pnl - a.pnl || a.losses - b.losses || b.wr - a.wr);

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    baseline: base,
    results: ranked.map((r) => ({
      ...r,
      wr: Number(r.wr.toFixed(1)),
      pnl: Number(r.pnl.toFixed(2)),
      pf: r.pf === Infinity ? null : Number(r.pf.toFixed(2)),
      avgPnl: Number(r.avgPnl.toFixed(2)),
      pnlDelta: Number(r.pnlDelta.toFixed(2)),
      wrDelta: Number(r.wrDelta.toFixed(1)),
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\n════════════════════════════════════════════════════════');
  console.log('Filtros ordenados por PnL');
  console.log('════════════════════════════════════════════════════════');
  console.table(
    ranked.map((r) => ({
      filtro: r.label,
      n: r.n,
      losses: r.losses,
      lossCut: r.lossCut,
      wr: r.wr.toFixed(1) + '%',
      pnl: (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(0),
      dPnl: (r.pnlDelta >= 0 ? '+' : '') + r.pnlDelta.toFixed(0),
      pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
      avg: r.avgPnl.toFixed(2),
    }))
  );
  console.log(`JSON → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
