/**
 * Auditoria da melhor combo Lista 50 spike:
 *   SL 12% · TP 30% @ +15% · resto 48h
 *
 * Lista nº de entradas, top 10 / bottom 10 e padrões nos piores.
 *
 * Uso:
 *   node src/backtests/study-lista50-spike-best-trade-audit.js
 *   node src/backtests/study-lista50-spike-best-trade-audit.js 60
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
const OUT = path.join(__dirname, 'out-lista50-spike-best-trade-audit.json');

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

function spikeInfo(candles, i) {
  if (i < Math.max(MA_PERIOD, VOL_LOOKBACK + 1) - 1) return null;
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
  return { ratio, bodyPct, rangePct, aboveMaPct, ma };
}

function closePart(fills, pos, exitPrice, exitTime, qty, tag) {
  if (!(qty > 0)) return;
  const gross = (exitPrice - pos.entryPrice) * qty;
  const fee = (pos.entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnl = gross - fee;
  fills.push({
    tag,
    exitPrice,
    exitTime,
    qty,
    pnl,
    pnlPct: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
  });
}

function simulate(ticker, candles) {
  const entries = [];
  let pos = null;
  const cutoff = candles[candles.length - 1].time.getTime() - DAYS * 24 * 3600 * 1000;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const t = bar.time.getTime();

    if (pos) {
      const mfePct = ((bar.high - pos.entryPrice) / pos.entryPrice) * 100;
      const maePct = ((bar.low - pos.entryPrice) / pos.entryPrice) * 100;
      if (mfePct > pos.mfePct) pos.mfePct = mfePct;
      if (maePct < pos.maePct) pos.maePct = maePct;

      const hours = (t - pos.entryTime) / 3600000;
      if (hours <= 1) {
        pos.mfe1h = Math.max(pos.mfe1h, mfePct);
        pos.mae1h = Math.min(pos.mae1h, maePct);
      }
      if (hours <= 4) {
        pos.mfe4h = Math.max(pos.mfe4h, mfePct);
        pos.mae4h = Math.min(pos.mae4h, maePct);
      }

      const slPrice = pos.entryPrice * (1 - SL_PCT);
      if (bar.low <= slPrice) {
        closePart(pos.fills, pos, slPrice, t, pos.remQty, 'sl');
        pos.remQty = 0;
        pos.exitReason = pos.tpDone ? 'tp_then_sl' : 'sl';
        pos.exitTime = t;
        pos.holdH = hours;
        entries.push(finalize(pos));
        pos = null;
        continue;
      }

      if (!pos.tpDone) {
        const tpPrice = pos.entryPrice * (1 + TP_PCT);
        if (bar.high >= tpPrice) {
          const closeQty = pos.qty * TP_FRAC;
          closePart(pos.fills, pos, tpPrice, t, closeQty, 'tp');
          pos.remQty -= closeQty;
          pos.tpDone = true;
          pos.tpTime = t;
          pos.hoursToTp = hours;
          if (pos.remQty <= 1e-12) {
            pos.exitReason = 'tp_full';
            pos.exitTime = t;
            pos.holdH = hours;
            entries.push(finalize(pos));
            pos = null;
            continue;
          }
        }
      }

      if (t >= pos.deadline) {
        closePart(pos.fills, pos, bar.close, t, pos.remQty, 'time48h');
        pos.remQty = 0;
        pos.exitReason = pos.tpDone ? 'tp_then_48h' : 'time48h';
        pos.exitTime = t;
        pos.holdH = hours;
        pos.exitClosePct = ((bar.close - pos.entryPrice) / pos.entryPrice) * 100;
        entries.push(finalize(pos));
        pos = null;
        continue;
      }
    }

    if (!pos && t >= cutoff) {
      const info = spikeInfo(candles, i);
      if (info) {
        const entryPrice = bar.close;
        const qty = NOTIONAL / entryPrice;
        const entryDate = new Date(t);
        pos = {
          ticker,
          entryPrice,
          entryTime: t,
          entryIso: entryDate.toISOString(),
          qty,
          remQty: qty,
          tpDone: false,
          deadline: t + HOLD_MS,
          spikeRatio: info.ratio,
          bodyPct: info.bodyPct,
          rangePct: info.rangePct,
          aboveMaPct: info.aboveMaPct,
          hourUtc: entryDate.getUTCHours(),
          dow: entryDate.getUTCDay(),
          mfePct: 0,
          maePct: 0,
          mfe1h: 0,
          mae1h: 0,
          mfe4h: 0,
          mae4h: 0,
          fills: [],
        };
      }
    }
  }

  if (pos) {
    const last = candles[candles.length - 1];
    const t = last.time.getTime();
    closePart(pos.fills, pos, last.close, t, pos.remQty, 'open');
    pos.exitReason = pos.tpDone ? 'tp_then_open' : 'open';
    pos.exitTime = t;
    pos.holdH = (t - pos.entryTime) / 3600000;
    pos.exitClosePct = ((last.close - pos.entryPrice) / pos.entryPrice) * 100;
    entries.push(finalize(pos));
  }
  return entries;
}

function finalize(pos) {
  const pnl = pos.fills.reduce((a, f) => a + f.pnl, 0);
  const tags = pos.fills.map((f) => f.tag);
  return {
    ticker: pos.ticker,
    entryTime: pos.entryTime,
    entryIso: pos.entryIso,
    exitTime: pos.exitTime,
    exitIso: new Date(pos.exitTime).toISOString(),
    entryPrice: pos.entryPrice,
    pnl: Number(pnl.toFixed(2)),
    pnlPct: Number((((pnl / NOTIONAL) * 100)).toFixed(2)),
    exitReason: pos.exitReason,
    tags,
    holdH: Number(pos.holdH.toFixed(2)),
    spikeRatio: Number(pos.spikeRatio.toFixed(2)),
    bodyPct: Number(pos.bodyPct.toFixed(2)),
    rangePct: Number(pos.rangePct.toFixed(2)),
    aboveMaPct: Number(pos.aboveMaPct.toFixed(2)),
    hourUtc: pos.hourUtc,
    dow: pos.dow,
    mfePct: Number(pos.mfePct.toFixed(2)),
    maePct: Number(pos.maePct.toFixed(2)),
    mfe1h: Number(pos.mfe1h.toFixed(2)),
    mae1h: Number(pos.mae1h.toFixed(2)),
    mfe4h: Number(pos.mfe4h.toFixed(2)),
    mae4h: Number(pos.mae4h.toFixed(2)),
    hoursToTp: pos.hoursToTp != null ? Number(pos.hoursToTp.toFixed(2)) : null,
    exitClosePct: pos.exitClosePct != null ? Number(pos.exitClosePct.toFixed(2)) : null,
    tpHit: pos.tpDone,
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

function avg(arr, key) {
  if (!arr.length) return 0;
  return arr.reduce((a, x) => a + x[key], 0) / arr.length;
}

function analyzeWorst(worst, all) {
  const n = worst.length;
  const slOnly = worst.filter((t) => t.exitReason === 'sl').length;
  const tpThenSl = worst.filter((t) => t.exitReason === 'tp_then_sl').length;
  const timeLoss = worst.filter((t) => t.exitReason === 'time48h' || t.exitReason === 'tp_then_48h').length;
  const neverGreen1h = worst.filter((t) => t.mfe1h < 1).length;
  const neverTp = worst.filter((t) => !t.tpHit).length;
  const deepMae4h = worst.filter((t) => t.mae4h <= -8).length;
  const highSpike = worst.filter((t) => t.spikeRatio >= 10).length;
  const byTicker = {};
  for (const t of worst) byTicker[t.ticker] = (byTicker[t.ticker] || 0) + 1;
  const topTickers = Object.entries(byTicker)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const byHour = {};
  for (const t of worst) byHour[t.hourUtc] = (byHour[t.hourUtc] || 0) + 1;

  return {
    n,
    slOnly,
    tpThenSl,
    timeLoss,
    neverGreen1h,
    neverTp,
    deepMae4h,
    highSpike,
    avgSpikeRatio: Number(avg(worst, 'spikeRatio').toFixed(2)),
    avgSpikeAll: Number(avg(all, 'spikeRatio').toFixed(2)),
    avgBodyPct: Number(avg(worst, 'bodyPct').toFixed(2)),
    avgBodyAll: Number(avg(all, 'bodyPct').toFixed(2)),
    avgAboveMa: Number(avg(worst, 'aboveMaPct').toFixed(2)),
    avgAboveMaAll: Number(avg(all, 'aboveMaPct').toFixed(2)),
    avgMfe1h: Number(avg(worst, 'mfe1h').toFixed(2)),
    avgMfe1hAll: Number(avg(all, 'mfe1h').toFixed(2)),
    avgMae4h: Number(avg(worst, 'mae4h').toFixed(2)),
    avgHoldH: Number(avg(worst, 'holdH').toFixed(2)),
    topTickers,
    byHour,
  };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados Bybit...');
  await exchange.loadMarkets();
  console.log(
    `Audit · Lista 50 spike · ${DAYS}d · SL ${SL_PCT * 100}% · TP ${TP_FRAC * 100}% @ +${TP_PCT * 100}% · resto 48h`
  );
  const data = await fetchUniverse(exchange);

  let all = [];
  for (const [ticker, candles] of Object.entries(data)) {
    all = all.concat(simulate(ticker, candles));
  }
  all.sort((a, b) => a.entryTime - b.entryTime);

  const closed = all.filter((t) => t.exitReason !== 'open' && t.exitReason !== 'tp_then_open');
  const sorted = closed.slice().sort((a, b) => b.pnl - a.pnl);
  const top10 = sorted.slice(0, 10);
  const worst10 = sorted.slice(-10).reverse();

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const totalPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const byReason = {};
  for (const t of closed) {
    byReason[t.exitReason] = byReason[t.exitReason] || { n: 0, pnl: 0 };
    byReason[t.exitReason].n++;
    byReason[t.exitReason].pnl += t.pnl;
  }

  const worstAnalysis = analyzeWorst(worst10, closed);
  // Also analyze all losses for stronger patterns
  const allLossAnalysis = analyzeWorst(losses, closed);

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    config: { slPct: SL_PCT, tpPct: TP_PCT, tpFrac: TP_FRAC, holdH: 48, notional: NOTIONAL },
    summary: {
      entries: closed.length,
      stillOpenish: all.length - closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      totalPnl: Number(totalPnl.toFixed(2)),
      byReason: Object.fromEntries(
        Object.entries(byReason).map(([k, v]) => [k, { n: v.n, pnl: Number(v.pnl.toFixed(2)) }])
      ),
    },
    top10,
    worst10,
    worstAnalysis,
    allLossAnalysis,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Melhor combo · ${DAYS}d · ${closed.length} trades fechados · PnL ${totalPnl.toFixed(2)}`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`WR ${(payload.summary.winRate).toFixed(1)}% · wins ${wins.length} · losses ${losses.length}`);
  console.log('\nPor saída:');
  console.table(
    Object.entries(byReason).map(([k, v]) => ({
      reason: k,
      n: v.n,
      pnl: v.pnl.toFixed(2),
    }))
  );

  console.log('\nTOP 10 melhores:');
  console.table(
    top10.map((t) => ({
      ticker: t.ticker,
      entry: t.entryIso.slice(0, 16),
      pnl: t.pnl,
      reason: t.exitReason,
      spike: t.spikeRatio,
      mfe: t.mfePct,
      holdH: t.holdH,
    }))
  );

  console.log('\nTOP 10 piores:');
  console.table(
    worst10.map((t) => ({
      ticker: t.ticker,
      entry: t.entryIso.slice(0, 16),
      pnl: t.pnl,
      reason: t.exitReason,
      spike: t.spikeRatio,
      mfe1h: t.mfe1h,
      mae4h: t.mae4h,
      mfe: t.mfePct,
      holdH: t.holdH,
    }))
  );

  console.log('\nPadrões nos 10 piores:');
  console.log(JSON.stringify(worstAnalysis, null, 2));
  console.log(`JSON → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
