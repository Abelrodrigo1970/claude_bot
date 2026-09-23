/**
 * Lista 50 spike LONG — TP parcial + fecho 48h (sweep).
 *
 * Entrada: spike ≥5× + verde + >SMA50 (15m), igual ao scanner.
 * Gestão: SL fixo · TP parcial (frac @ +pct) · resto às 48h.
 *
 * Uso:
 *   node src/backtests/study-lista50-spike-tp48h-sweep.js
 *   node src/backtests/study-lista50-spike-tp48h-sweep.js 60
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
const SPIKE_RATIO = 5;
const MA_PERIOD = 50;
const VOL_LOOKBACK = 10;
const HOLD_MS = 48 * 60 * 60 * 1000;

const SL_LIST = [0.08, 0.12];
const TP_CONFIGS = [
  { tpPct: 0.1, tpFrac: 0.5, label: '50%@+10%' },
  { tpPct: 0.12, tpFrac: 0.5, label: '50%@+12%' },
  { tpPct: 0.15, tpFrac: 0.5, label: '50%@+15%' },
  { tpPct: 0.2, tpFrac: 0.5, label: '50%@+20%' },
  { tpPct: 0.15, tpFrac: 0.3, label: '30%@+15%' },
  { tpPct: 0.15, tpFrac: 0.7, label: '70%@+15%' },
];

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map((m) => m.symbol);
const OUT = path.join(__dirname, 'out-lista50-spike-tp48h-sweep.json');

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
  if (cur.volume / avgVol < SPIKE_RATIO) return false;
  const closes = [];
  for (let j = i - MA_PERIOD + 1; j <= i; j++) closes.push(candles[j].close);
  const ma = sma(closes, MA_PERIOD);
  return ma != null && cur.close > ma;
}

function closePart(trades, pos, exitPrice, exitTime, qty, tag) {
  if (!(qty > 0)) return;
  const gross = (exitPrice - pos.entryPrice) * qty;
  const fee = (pos.entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  trades.push({
    ticker: pos.ticker,
    entryTime: pos.entryTime,
    exitTime,
    pnl: gross - fee,
    tag,
  });
}

function simulate(ticker, candles, slPct, tpPct, tpFrac) {
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
        const tpPrice = pos.entryPrice * (1 + tpPct);
        if (bar.high >= tpPrice) {
          const closeQty = pos.qty * tpFrac;
          closePart(trades, pos, tpPrice, t, closeQty, 'tp');
          pos.remQty -= closeQty;
          pos.tpDone = true;
          if (pos.remQty <= 1e-12) {
            pos = null;
            continue;
          }
        }
      }

      if (t >= pos.deadline) {
        closePart(trades, pos, bar.close, t, pos.remQty, 'time48h');
        pos = null;
        continue;
      }
    }

    if (!pos && t >= cutoff && isSpikeBar(candles, i)) {
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
    if (!map.has(key)) map.set(key, { pnl: 0 });
    map.get(key).pnl += t.pnl;
  }
  return [...map.values()];
}

function summarize(trades, openMtm, openCount) {
  const wins = trades.filter((t) => t.pnl > 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
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
      if (candles.length < MA_PERIOD + VOL_LOOKBACK + 10) continue;
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
  console.log('A carregar mercados Bybit...');
  await exchange.loadMarkets();
  console.log(
    `Lista 50 spike · ${DAYS}d · fecho 48h · SL [${SL_LIST.map((s) => s * 100 + '%').join(',')}] · TP configs ${TP_CONFIGS.length}`
  );
  const data = await fetchUniverse(exchange);

  const results = [];
  for (const slPct of SL_LIST) {
    for (const tp of TP_CONFIGS) {
      let allTrades = [];
      let openMtm = 0;
      let openCount = 0;
      for (const [ticker, candles] of Object.entries(data)) {
        const r = simulate(ticker, candles, slPct, tp.tpPct, tp.tpFrac);
        allTrades = allTrades.concat(r.trades);
        openMtm += r.openMtm;
        if (r.stillOpen) openCount++;
      }
      allTrades.sort((a, b) => a.exitTime - b.exitTime);
      const summary = summarize(allTrades, openMtm, openCount);
      results.push({
        slLabel: `${(slPct * 100).toFixed(0)}%`,
        tpLabel: tp.label,
        slPct,
        ...tp,
        ...summary,
      });
    }
  }

  results.sort((a, b) => b.totalPnl - a.totalPnl);

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    notional: NOTIONAL,
    holdHours: 48,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Lista 50 spike · TP parcial + 48h · ${DAYS}d (ordenado por PnL)`);
  console.log('════════════════════════════════════════════════════════');
  console.table(
    results.map((r) => ({
      SL: r.slLabel,
      TP: r.tpLabel,
      entries: r.entries,
      wr: r.entryWinRate.toFixed(1) + '%',
      pnl: (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(2),
      pnlMtm: (r.totalWithMtm >= 0 ? '+' : '') + r.totalWithMtm.toFixed(2),
      pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
      maxDD: r.maxDD.toFixed(2),
      slN: r.byTag.sl || 0,
      tpN: r.byTag.tp || 0,
      t48N: r.byTag.time48h || 0,
      pnlSL: r.pnlByTag.sl ?? 0,
      pnlTP: r.pnlByTag.tp ?? 0,
      pnl48: r.pnlByTag.time48h ?? 0,
    }))
  );
  console.log(`JSON → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
