/**
 * Estudo: Lista 50 (spike) — LONG sempre que houver spike sinalizado.
 *
 * Spike (igual ao scanner CriptoBot):
 *   volume da vela 15m fechada ≥ 5× média das 10 anteriores
 *   E close > open
 *   E close > SMA(50) 15m  (filtro da lista)
 *
 * Gestão pedida:
 *   SL −5%
 *   TP parcial: 50% da posição a +15%
 *   Restante: fecha 24h após a entrada
 *
 * Uso:
 *   node src/backtests/study-lista50-spike-sl5-tp15-24h.js
 *   node src/backtests/study-lista50-spike-sl5-tp15-24h.js 60
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
const SL_PCT = 0.05;
const TP_PCT = 0.15;
const TP_FRAC = 0.5;
const HOLD_MS = 24 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map((m) => m.symbol);
const OUT = path.join(__dirname, 'out-lista50-spike-sl5-tp15-24h.json');

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
  const pnl = gross - fee;
  const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  trades.push({
    ticker: pos.ticker,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice,
    exitTime,
    qty,
    pnl,
    pnlPct,
    tag,
    holdH: (exitTime - pos.entryTime) / 3600000,
  });
}

function simulate(ticker, candles) {
  const trades = [];
  let pos = null; // { ticker, entryPrice, entryTime, qty, remQty, tpDone, deadline }

  // Só conta sinais no período de estudo (últimos DAYS), com warm-up para SMA/volume
  const cutoff = candles[candles.length - 1].time.getTime() - DAYS * 24 * 3600 * 1000;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const t = bar.time.getTime();

    if (pos) {
      // 1) SL (low da vela) — prioridade sobre TP na mesma vela (conservador)
      const slPrice = pos.entryPrice * (1 - SL_PCT);
      if (bar.low <= slPrice) {
        closePart(trades, pos, slPrice, t, pos.remQty, 'sl');
        pos = null;
        continue;
      }

      // 2) TP parcial +15% (high da vela)
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

      // 3) Restante às 24h (ao close da vela em que passou o prazo)
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
          spikeRatio: spike.ratio,
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

function stats(trades) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
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
  const avgPnlPct = trades.length
    ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length
    : 0;
  return {
    fills: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    pf,
    maxDD,
    avgPnlPct,
    byTag,
    pnlByTag,
  };
}

/** Agrupa fills do mesmo entryTime num "trade" completo (para winrate por entrada). */
function groupEntries(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = `${t.ticker}|${t.entryTime}`;
    if (!map.has(key)) {
      map.set(key, {
        ticker: t.ticker,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        pnl: 0,
        tags: [],
      });
    }
    const g = map.get(key);
    g.pnl += t.pnl;
    g.tags.push(t.tag);
  }
  return [...map.values()];
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
  console.log(
    `\n[${TIMEFRAME}] ${ok} ok, ${skipped.length} ignorados${skipped.length ? ' (' + skipped.join(',') + ')' : ''}`
  );
  return out;
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados Bybit...');
  await exchange.loadMarkets();

  console.log(`Universo: ${SYMBOLS.length} símbolos (Lista 50)`);
  console.log(
    `Estudo ${DAYS}d · spike ≥${SPIKE_RATIO}x + verde + >SMA${MA_PERIOD} · SL ${SL_PCT * 100}% · TP ${TP_FRAC * 100}% @ +${TP_PCT * 100}% · resto ${HOLD_MS / 3600000}h · size ${NOTIONAL} USDT`
  );
  console.log(`A obter velas ${TIMEFRAME} (~${candlesNeeded()} por símbolo)...`);
  const data = await fetchUniverse(exchange);

  let allTrades = [];
  let openMtm = 0;
  let openCount = 0;
  const perTicker = {};

  for (const [ticker, candles] of Object.entries(data)) {
    const { trades, stillOpen, openMtm: mtm } = simulate(ticker, candles);
    perTicker[ticker] = stats(trades);
    allTrades = allTrades.concat(trades);
    openMtm += mtm;
    if (stillOpen) openCount++;
  }

  allTrades.sort((a, b) => a.exitTime - b.exitTime);
  const fillStats = stats(allTrades);
  const entries = groupEntries(allTrades);
  const entryWins = entries.filter((e) => e.pnl > 0).length;
  const entryWinRate = entries.length ? (entryWins / entries.length) * 100 : 0;
  const entryPnl = entries.reduce((a, e) => a + e.pnl, 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    notional: NOTIONAL,
    rules: {
      spikeRatio: SPIKE_RATIO,
      smaPeriod: MA_PERIOD,
      slPct: SL_PCT,
      tpPct: TP_PCT,
      tpFrac: TP_FRAC,
      holdHours: HOLD_MS / 3600000,
      timeframe: TIMEFRAME,
    },
    symbolsOk: Object.keys(data).length,
    fillStats,
    entries: {
      count: entries.length,
      wins: entryWins,
      winRate: entryWinRate,
      totalPnl: entryPnl,
    },
    openCount,
    openMtm,
    totalPnlWithMtm: fillStats.totalPnl + openMtm,
    perTicker,
    sampleTrades: allTrades.slice(-30),
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Lista 50 spike LONG · ${DAYS}d · SL ${SL_PCT * 100}% · TP ${TP_FRAC * 100}%@+${TP_PCT * 100}% · resto 24h`);
  console.log('════════════════════════════════════════════════════════');
  console.log(
    `Entradas (spikes): ${entries.length} · Win rate/entrada: ${entryWinRate.toFixed(1)}% · PnL: ${entryPnl >= 0 ? '+' : ''}${entryPnl.toFixed(2)} USDT`
  );
  console.log(
    `Fills (parcial+resto): ${fillStats.fills} · WR fills: ${fillStats.winRate.toFixed(1)}% · Avg % fill: ${fillStats.avgPnlPct.toFixed(2)}%`
  );
  console.log(
    `PnL fills: ${fillStats.totalPnl >= 0 ? '+' : ''}${fillStats.totalPnl.toFixed(2)} · MtM abertas (${openCount}): ${openMtm >= 0 ? '+' : ''}${openMtm.toFixed(2)} · Total: ${(fillStats.totalPnl + openMtm) >= 0 ? '+' : ''}${(fillStats.totalPnl + openMtm).toFixed(2)} USDT`
  );
  console.log(
    `PF: ${fillStats.pf === Infinity ? '∞' : fillStats.pf.toFixed(2)} · Max DD: ${fillStats.maxDD.toFixed(2)}`
  );
  console.log('Saídas:', JSON.stringify(fillStats.byTag));
  console.log(
    'PnL por saída:',
    Object.fromEntries(
      Object.entries(fillStats.pnlByTag).map(([k, v]) => [k, Number(v.toFixed(2))])
    )
  );

  const rows = Object.entries(perTicker)
    .filter(([, s]) => s.fills > 0)
    .map(([ticker, s]) => ({
      ticker,
      fills: s.fills,
      wr: s.winRate.toFixed(1) + '%',
      pnl: s.totalPnl.toFixed(2),
      exits: JSON.stringify(s.byTag),
    }))
    .sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  console.log('\nPor símbolo (com fills):');
  console.table(rows.slice(0, 25));
  console.log(`\nJSON → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
