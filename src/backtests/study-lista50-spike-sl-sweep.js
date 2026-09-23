/**
 * Sweep SL na Lista 50 spike LONG (mesma entrada do scanner).
 * TP parcial 50% @ +15% · resto às 24h · size 80 USDT
 *
 * Uso:
 *   node src/backtests/study-lista50-spike-sl-sweep.js
 *   node src/backtests/study-lista50-spike-sl-sweep.js 60
 *   node src/backtests/study-lista50-spike-sl-sweep.js 30 5,8,10,12
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL = 80;
const TAKER_FEE = 0.00055;
const TIMEFRAME = '15m';
const DAYS = parseInt(process.argv[2], 10) || 30;
const SL_LIST = (process.argv[3] || '8,10,12')
  .split(',')
  .map((s) => parseFloat(s.trim()) / 100)
  .filter((n) => Number.isFinite(n) && n > 0);

const SPIKE_RATIO = 5;
const MA_PERIOD = 50;
const VOL_LOOKBACK = 10;
const TP_PCT = 0.15;
const TP_FRAC = 0.5;
const HOLD_MS = 24 * 60 * 60 * 1000;

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map((m) => m.symbol);
const OUT = path.join(__dirname, 'out-lista50-spike-sl-sweep.json');

function candlesNeeded() {
  const barsPerDay = (24 * 60) / 15;
  return Math.round(DAYS * barsPerDay) + MA_PERIOD + VOL_LOOKBACK + 20;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

function isSpikeBar(candles, i) {
  if (i < Math.max(MA_PERIOD, VOL_LOOKBACK + 1) - 1) return false;
  const cur = candles[i];
  if (!(cur.close > cur.open)) return false;
  let volSum = 0;
  for (let j = i - VOL_LOOKBACK; j < i; j++) volSum += candles[j].volume;
  const avgVol = volSum / VOL_LOOKBACK;
  if (!(avgVol > 0)) return false;
  const ratio = cur.volume / avgVol;
  if (ratio < SPIKE_RATIO) return false;
  const closes = [];
  for (let j = i - MA_PERIOD + 1; j <= i; j++) closes.push(candles[j].close);
  const ma = sma(closes, MA_PERIOD);
  if (ma == null || !(cur.close > ma)) return false;
  return { ratio };
}

function closePart(trades, pos, exitPrice, exitTime, qty, tag) {
  if (!(qty > 0)) return;
  const gross = (exitPrice - pos.entryPrice) * qty;
  const fee = (pos.entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  trades.push({
    ticker: pos.ticker,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice,
    exitTime,
    qty,
    pnl: gross - fee,
    pnlPct: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
    tag,
  });
}

function simulate(ticker, candles, slPct) {
  const trades = [];
  let pos = null;
  const cutoff = candles[candles.length - 1].time.getTime() - DAYS * 24 * 3600 * 1000;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const t = bar.time.getTime();

    if (pos) {
      const slPrice = pos.entryPrice * (1 - slPct);
      if (bar.low <= slPrice) {
        closePart(trades, pos, slPrice, t, pos.remQty, 'sl');
        pos = null;
        continue;
      }

      if (!pos.tpDone) {
        const tpPrice = pos.entryPrice * (1 + TP_PCT);
        if (bar.high >= tpPrice) {
          const closeQty = pos.qty * TP_FRAC;
          closePart(trades, pos, tpPrice, t, closeQty, 'tp15');
          pos.remQty -= closeQty;
          pos.tpDone = true;
          if (pos.remQty <= 1e-12) {
            pos = null;
            continue;
          }
        }
      }

      if (t >= pos.deadline) {
        closePart(trades, pos, bar.close, t, pos.remQty, 'time24h');
        pos = null;
        continue;
      }
    }

    if (!pos && t >= cutoff) {
      const spike = isSpikeBar(candles, i);
      if (spike) {
        const entryPrice = bar.close;
        const qty = NOTIONAL / entryPrice;
        pos = {
          ticker,
          entryPrice,
          entryTime: t,
          qty,
          remQty: qty,
          tpDone: false,
          deadline: t + HOLD_MS,
        };
      }
    }
  }

  let openMtm = 0;
  if (pos) {
    const last = candles[candles.length - 1];
    openMtm = (last.close - pos.entryPrice) * pos.remQty;
  }
  return { trades, stillOpen: !!pos, openMtm };
}

function groupEntries(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = `${t.ticker}|${t.entryTime}`;
    if (!map.has(key)) {
      map.set(key, { ticker: t.ticker, entryTime: t.entryTime, pnl: 0 });
    }
    map.get(key).pnl += t.pnl;
  }
  return [...map.values()];
}

function summarize(trades, openMtm, openCount) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades.slice().sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }
  const byTag = {};
  const pnlByTag = {};
  for (const t of trades) {
    byTag[t.tag] = (byTag[t.tag] || 0) + 1;
    pnlByTag[t.tag] = (pnlByTag[t.tag] || 0) + t.pnl;
  }
  const entries = groupEntries(trades);
  const entryWins = entries.filter((e) => e.pnl > 0).length;
  return {
    entries: entries.length,
    entryWinRate: entries.length ? (entryWins / entries.length) * 100 : 0,
    fills: trades.length,
    fillWinRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPnl,
    openCount,
    openMtm,
    totalWithMtm: totalPnl + openMtm,
    pf,
    maxDD,
    byTag,
    pnlByTag: Object.fromEntries(
      Object.entries(pnlByTag).map(([k, v]) => [k, Number(v.toFixed(2))])
    ),
  };
}

async function fetchUniverse(exchange) {
  const total = candlesNeeded();
  const out = {};
  let ok = 0;
  const skipped = [];
  for (const symbol of SYMBOLS) {
    const ticker = symbol.split('/')[0];
    try {
      if (!exchange.markets[symbol]) {
        skipped.push(ticker);
        continue;
      }
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total);
      const candles = ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
        time: new Date(time),
        open,
        high,
        low,
        close,
        volume,
      }));
      if (candles.length < MA_PERIOD + VOL_LOOKBACK + 10) {
        skipped.push(ticker);
        continue;
      }
      out[ticker] = candles;
      ok++;
      process.stdout.write('.');
    } catch {
      skipped.push(ticker);
      process.stdout.write('x');
    }
  }
  console.log(`\n[${TIMEFRAME}] ${ok} ok, ${skipped.length} ignorados`);
  return out;
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados Bybit...');
  await exchange.loadMarkets();
  console.log(
    `Lista 50 spike · ${DAYS}d · SL sweep [${SL_LIST.map((s) => s * 100 + '%').join(', ')}] · TP 50%@15% · resto 24h · ${NOTIONAL} USDT`
  );
  console.log(`A obter velas (~${candlesNeeded()} / símbolo)...`);
  const data = await fetchUniverse(exchange);

  const results = [];
  for (const slPct of SL_LIST) {
    let allTrades = [];
    let openMtm = 0;
    let openCount = 0;
    for (const [ticker, candles] of Object.entries(data)) {
      const { trades, stillOpen, openMtm: mtm } = simulate(ticker, candles, slPct);
      allTrades = allTrades.concat(trades);
      openMtm += mtm;
      if (stillOpen) openCount++;
    }
    allTrades.sort((a, b) => a.exitTime - b.exitTime);
    const summary = summarize(allTrades, openMtm, openCount);
    results.push({ slPct, slLabel: `${(slPct * 100).toFixed(0)}%`, ...summary });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    notional: NOTIONAL,
    tpPct: TP_PCT,
    tpFrac: TP_FRAC,
    holdHours: 24,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Lista 50 spike LONG · SL sweep · ${DAYS}d`);
  console.log('════════════════════════════════════════════════════════');
  console.table(
    results.map((r) => ({
      SL: r.slLabel,
      entries: r.entries,
      wrEntry: r.entryWinRate.toFixed(1) + '%',
      fills: r.fills,
      pnl: (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(2),
      pnlMtm: (r.totalWithMtm >= 0 ? '+' : '') + r.totalWithMtm.toFixed(2),
      pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
      maxDD: r.maxDD.toFixed(2),
      slN: r.byTag.sl || 0,
      tpN: r.byTag.tp15 || 0,
      t24N: r.byTag.time24h || 0,
      pnlSL: r.pnlByTag.sl ?? 0,
      pnlTP: r.pnlByTag.tp15 ?? 0,
      pnl24: r.pnlByTag.time24h ?? 0,
    }))
  );
  console.log(`JSON → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
