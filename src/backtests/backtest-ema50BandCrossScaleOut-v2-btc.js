// Testa a relação com o BTC, pedido pelo utilizador (03/09), como possível
// forma de reduzir o drawdown da Ema50BandCrossScaleOut V2 (ver
// backtest-ema50BandCrossScaleOut-v2.js / -capped.js): a ideia é que os
// 47 altcoins do universo se movem correlacionados com o BTC — se muitos
// trades perdedores acontecem quando o BTC está em baixa, um filtro de
// regime (só abrir novas posições quando o BTC também está em tendência de
// alta) devia reduzir os episódios de perdas simultâneas.
//
// Duas partes:
//   1) Diagnóstico: corre a simulação SEM filtro de BTC (mesma lógica do V2
//      + filtro de vela de entrada) e separa o PnL dos trades consoante o
//      regime do BTC (preço acima/abaixo da própria EMA50 de 4h) no
//      momento da ENTRADA — mostra se a relação existe de facto.
//   2) Filtro real: repete a simulação mas só permite novas entradas quando
//      o BTC está acima da sua EMA50 de 4h — compara PnL/drawdown com e
//      sem o filtro.
//
// Corre com: node src/backtests/backtest-ema50BandCrossScaleOut-v2-btc.js [dias]
require('dotenv').config();
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');
const strat = require('../strategies/ema50BandCrossScaleOut');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL  = 60;
const TAKER_FEE = 0.00055;
const WINDOW    = 250;
const TIMEFRAME = '4h';
const DAYS      = parseInt(process.argv[2], 10) || 90;
const SL_PCT    = 0.10;
const TP_TIERS  = [
  { pct: 0.28, fraction: 0.30 },
  { pct: 0.48, fraction: 0.30 },
];
const EMA50_EXIT_BAND_PCT = 2;
const RSI_EXIT_MAX = 87;
const ENTRY_CANDLE_MAX_PCT = 20;
const BTC_EMA_PERIOD = 50;

const SYMBOLS = [
  'AKE/USDT:USDT', 'BR/USDT:USDT', 'CHIP/USDT:USDT', '4/USDT:USDT', 'ENA/USDT:USDT',
  'ARB/USDT:USDT', 'CRV/USDT:USDT', 'EGLD/USDT:USDT', 'CVX/USDT:USDT', 'ACE/USDT:USDT',
  'BOME/USDT:USDT', 'EDU/USDT:USDT', 'BMNR/USDT:USDT', 'AAVE/USDT:USDT', 'ACU/USDT:USDT',
  'AR/USDT:USDT', 'CAKE/USDT:USDT', 'EDGE/USDT:USDT', 'APR/USDT:USDT', 'DASH/USDT:USDT',
  'CRCL/USDT:USDT', 'BROCCOLI/USDT:USDT', 'COTI/USDT:USDT', '1000NEIROCTO/USDT:USDT', 'AGI/USDT:USDT',
  'BTR/USDT:USDT', '1000PEPE/USDT:USDT', 'EDEN/USDT:USDT', '1000CAT/USDT:USDT', 'CETUS/USDT:USDT',
  'BMT/USDT:USDT', 'ADA/USDT:USDT', 'BTC/USDT:USDT', 'ENS/USDT:USDT', 'BSV/USDT:USDT',
  'BNB/USDT:USDT', '1000RATS/USDT:USDT', '1000000BABYDOGE/USDT:USDT', 'COIN/USDT:USDT', 'CHILLGUY/USDT:USDT',
  'CROSS/USDT:USDT', 'A/USDT:USDT', 'AERO/USDT:USDT', 'CELO/USDT:USDT', 'COMP/USDT:USDT',
  'ENSO/USDT:USDT', '1INCH/USDT:USDT',
];

function candlesNeeded() {
  const barsPerDay = 24 / 4;
  return Math.round(DAYS * barsPerDay) + WINDOW + 10;
}

async function fetchUniverse(exchange) {
  const total = candlesNeeded();
  const out = {};
  let ok = 0, skipped = [];
  for (const symbol of SYMBOLS) {
    const ticker = symbol.split('/')[0];
    try {
      if (!exchange.markets[symbol]) { skipped.push(ticker); continue; }
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total);
      const candles = ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
        time: new Date(time), open, high, low, close, volume,
      }));
      if (candles.length < WINDOW + 65) { skipped.push(ticker); continue; }
      out[ticker] = candles;
      ok++;
      process.stdout.write('.');
    } catch {
      skipped.push(ticker);
      process.stdout.write('x');
    }
  }
  console.log(`\n[${TIMEFRAME}] ${ok} ok, ${skipped.length} ignorados${skipped.length ? ' (' + skipped.join(',') + ')' : ''}`);
  return out;
}

// Mapa time->bool: BTC fechou acima da sua própria EMA50 (4h) nessa vela.
function buildBtcRegime(btcCandles) {
  const closes = btcCandles.map(c => c.close);
  const emaArr = EMA.calculate({ period: BTC_EMA_PERIOD, values: closes });
  const regime = new Map();
  for (let i = 0; i < btcCandles.length; i++) {
    const emaIdx = i - (BTC_EMA_PERIOD - 1);
    if (emaIdx < 0 || emaIdx >= emaArr.length) continue;
    regime.set(btcCandles[i].time.getTime(), btcCandles[i].close > emaArr[emaIdx]);
  }
  return regime;
}

function closeTrade(trades, ticker, entryPrice, entryTime, exitPrice, exitTime, qty, tag, btcBullishAtEntry) {
  const grossPnl = (exitPrice - entryPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  trades.push({ ticker, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag, btcBullishAtEntry });
}

function precompute(candles) {
  const minCandles = strat.EMA_SLOW_PERIOD + strat.RSI_PERIOD + 10;
  const events = new Map();
  for (let i = 0; i < candles.length; i++) {
    if (i < minCandles - 1) continue;
    const bar = candles[i];
    const start = Math.max(0, i - WINDOW + 1);
    const window = candles.slice(start, i + 1);
    const ind = strat.calculateIndicators(window);
    const entryCandleMovePct = bar.open > 0 ? Math.abs((bar.close - bar.open) / bar.open) * 100 : 0;
    const entryOk = ind.validEntry && entryCandleMovePct <= ENTRY_CANDLE_MAX_PCT;
    const belowEma50Band = ind.ema50 != null && bar.close < ind.ema50 * (1 - EMA50_EXIT_BAND_PCT / 100);
    const rsiOverbought  = ind.rsi != null && ind.rsi > RSI_EXIT_MAX;
    events.set(bar.time.getTime(), {
      price: bar.close, entryOk, exitSignal: belowEma50Band || rsiOverbought,
      exitTag: belowEma50Band ? 'ema50-2pct-exit' : (rsiOverbought ? 'rsi87-exit' : null),
    });
  }
  return events;
}

// Simulação por símbolo independente (sem limite de posições concorrentes),
// com filtro opcional de regime do BTC nas novas entradas.
function simulate(ticker, events, timeline, btcRegime, requireBtcBullish) {
  const trades = [];
  let pos = null;

  for (const t of timeline) {
    const ev = events.get(t);
    if (!ev) continue;
    const price = ev.price;

    if (pos) {
      const tier = TP_TIERS[pos.tpTierIndex];
      if (tier) {
        const gainPct = (price - pos.entryPrice) / pos.entryPrice;
        if (gainPct >= tier.pct) {
          const closeQty = pos.qty * tier.fraction;
          closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, new Date(t), closeQty, `tp${pos.tpTierIndex + 1}`, pos.btcBullishAtEntry);
          pos.qty -= closeQty;
          pos.tpTierIndex++;
          if (pos.qty <= 1e-9) pos = null;
        }
      }
    }
    if (pos) {
      const lossPct = (pos.entryPrice - price) / pos.entryPrice;
      if (lossPct >= SL_PCT) {
        closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, new Date(t), pos.qty, 'stop-loss', pos.btcBullishAtEntry);
        pos = null; continue;
      }
      if (ev.exitSignal) {
        closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, new Date(t), pos.qty, ev.exitTag, pos.btcBullishAtEntry);
        pos = null; continue;
      }
    }

    if (!pos && ev.entryOk) {
      const btcBullish = btcRegime.get(t);
      if (requireBtcBullish && btcBullish !== true) continue; // BTC em baixa (ou sem dados) — não entra
      pos = { entryPrice: price, entryTime: new Date(t), qty: NOTIONAL / price, tpTierIndex: 0, btcBullishAtEntry: btcBullish ?? null };
    }
  }

  let openMtmPnl = 0;
  if (pos) {
    const lastT = timeline[timeline.length - 1];
    const ev = events.get(lastT);
    const lastPrice = ev ? ev.price : pos.entryPrice;
    openMtmPnl = (lastPrice - pos.entryPrice) * pos.qty;
  }
  return { trades, stillOpen: !!pos, openMtmPnl };
}

function stats(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades.slice().sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.pnl; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity - peak);
  }
  return { trades: trades.length, winRate, totalPnl, pf, maxDD };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  console.log(`Universo: ${SYMBOLS.length} símbolos (snapshot scanner EMA90, 03/09/2026)`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo, ${DAYS} dias)...`);
  const data = await fetchUniverse(exchange);

  const btcCandles = data['BTC'];
  const btcRegime = buildBtcRegime(btcCandles);

  const eventsByTicker = {};
  for (const [ticker, candles] of Object.entries(data)) eventsByTicker[ticker] = precompute(candles);

  const timeSet = new Set();
  for (const events of Object.values(eventsByTicker)) for (const t of events.keys()) timeSet.add(t);
  const timeline = Array.from(timeSet).sort((a, b) => a - b);

  // ---- Parte 1: diagnóstico (sem filtro), separa PnL por regime do BTC na entrada ----
  let allTradesNoFilter = [];
  for (const [ticker, events] of Object.entries(eventsByTicker)) {
    const { trades } = simulate(ticker, events, timeline, btcRegime, false);
    allTradesNoFilter = allTradesNoFilter.concat(trades);
  }
  const bullTrades = allTradesNoFilter.filter(t => t.btcBullishAtEntry === true);
  const bearTrades = allTradesNoFilter.filter(t => t.btcBullishAtEntry === false);
  const noDataTrades = allTradesNoFilter.filter(t => t.btcBullishAtEntry == null);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('PARTE 1 — Diagnóstico: PnL por regime do BTC no momento da ENTRADA (sem filtro)');
  console.log('════════════════════════════════════════════════════════');
  console.table([
    { regime: 'BTC > EMA50 (bullish)', ...stats(bullTrades) },
    { regime: 'BTC < EMA50 (bearish)', ...stats(bearTrades) },
    { regime: 'sem dados BTC', ...stats(noDataTrades) },
  ].map(r => ({ regime: r.regime, trades: r.trades, winRate: r.winRate.toFixed(1) + '%', pnlTotal: r.totalPnl.toFixed(2), pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2), pnlPorTrade: r.trades ? (r.totalPnl / r.trades).toFixed(3) : '-' })));

  // ---- Parte 2: com filtro (só entra se BTC > EMA50) ----
  let allTradesFiltered = [];
  let openMtm = 0, openCount = 0;
  for (const [ticker, events] of Object.entries(eventsByTicker)) {
    const { trades, stillOpen, openMtmPnl } = simulate(ticker, events, timeline, btcRegime, true);
    allTradesFiltered = allTradesFiltered.concat(trades);
    openMtm += openMtmPnl;
    if (stillOpen) openCount++;
  }
  const noFilterStats = stats(allTradesNoFilter);
  const filteredStats = stats(allTradesFiltered);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('PARTE 2 — Com filtro (só abre novas posições se BTC > EMA50 de 4h)');
  console.log('════════════════════════════════════════════════════════');
  console.table([
    { versao: 'Sem filtro BTC', trades: noFilterStats.trades, winRate: noFilterStats.winRate.toFixed(1) + '%', pnlTotal: noFilterStats.totalPnl.toFixed(2), pf: noFilterStats.pf === Infinity ? '∞' : noFilterStats.pf.toFixed(2), maxDD: noFilterStats.maxDD.toFixed(2) },
    { versao: 'Com filtro BTC>EMA50', trades: filteredStats.trades, winRate: filteredStats.winRate.toFixed(1) + '%', pnlTotal: filteredStats.totalPnl.toFixed(2), pf: filteredStats.pf === Infinity ? '∞' : filteredStats.pf.toFixed(2), maxDD: filteredStats.maxDD.toFixed(2) },
  ]);
  console.log(`\nCom filtro — ainda abertas: ${openCount}, MtM: ${openMtm.toFixed(2)}, PnL total (fechados+MtM): ${(filteredStats.totalPnl + openMtm).toFixed(2)}`);
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
