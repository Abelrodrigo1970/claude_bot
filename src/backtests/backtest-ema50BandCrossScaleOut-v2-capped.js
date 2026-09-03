// Variante de estudo da Ema50BandCrossScaleOut V2 (ver
// backtest-ema50BandCrossScaleOut-v2.js) que testa um limite de posições
// concorrentes — hipótese do utilizador (03/09): o drawdown grande
// (-667 USDT vs +719 de lucro) vem de os 47 símbolos poderem abrir posição
// todos ao mesmo tempo numa correção de mercado cripto (movem-se
// correlacionados), empilhando perdas simultâneas sem limite.
//
// Ao contrário dos outros scripts (que simulam cada símbolo isoladamente,
// sem noção do que se passa nos outros), este corre uma simulação de
// PORTEFÓLIO: percorre todos os símbolos em sincronia, vela a vela, e só
// abre uma posição nova se o número de posições abertas em simultâneo
// (em qualquer símbolo) estiver abaixo do limite testado. Candidatos a
// entrada processados por ordem fixa (a mesma do array SYMBOLS) — quando
// há mais sinais válidos do que vagas livres nessa vela, os primeiros da
// lista ganham a vaga (viés reconhecido, sem prioridade mais sofisticada).
//
// Corre com: node src/backtests/backtest-ema50BandCrossScaleOut-v2-capped.js [dias]
require('dotenv').config();
const ccxt = require('ccxt');
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
const MAX_CONCURRENT_CANDIDATES = [5, 8, 12, 20, Infinity]; // Infinity = baseline sem limite

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

function closeTrade(trades, ticker, entryPrice, entryTime, exitPrice, exitTime, qty, tag) {
  const grossPnl = (exitPrice - entryPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  trades.push({ ticker, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag });
}

// Pré-computa, por símbolo, os indicadores e a decisão de entrada/saída em
// cada vela — reutilizado em todos os limites testados (o cap só decide QUAL
// sinal se transforma em posição real, não recalcula indicadores).
function precompute(ticker, candles) {
  const minCandles = strat.EMA_SLOW_PERIOD + strat.RSI_PERIOD + 10;
  const events = new Map(); // time.getTime() -> { price, open, entryOk, exitReason }
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

function runPortfolio(perSymbolEvents, timeline, maxConcurrent) {
  const trades = [];
  const positions = {}; // ticker -> { entryPrice, entryTime, qty, tpTierIndex }
  let openCount = 0;

  for (const t of timeline) {
    // 1) Gestão de posições já abertas (TP/SL/saída por sinal) — sempre,
    //    independente do limite (o cap só trava ENTRADAS novas).
    for (const ticker of Object.keys(positions)) {
      const ev = perSymbolEvents[ticker].get(t);
      if (!ev) continue;
      const pos = positions[ticker];
      const price = ev.price;

      const tier = TP_TIERS[pos.tpTierIndex];
      if (tier) {
        const gainPct = (price - pos.entryPrice) / pos.entryPrice;
        if (gainPct >= tier.pct) {
          const closeQty = pos.qty * tier.fraction;
          closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, new Date(t), closeQty, `tp${pos.tpTierIndex + 1}`);
          pos.qty -= closeQty;
          pos.tpTierIndex++;
          if (pos.qty <= 1e-9) { delete positions[ticker]; openCount--; continue; }
        }
      }
      const lossPct = (pos.entryPrice - price) / pos.entryPrice;
      if (lossPct >= SL_PCT) {
        closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, new Date(t), pos.qty, 'stop-loss');
        delete positions[ticker]; openCount--; continue;
      }
      if (ev.exitSignal) {
        closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, new Date(t), pos.qty, ev.exitTag);
        delete positions[ticker]; openCount--; continue;
      }
    }

    // 2) Novas entradas — só até ao limite de posições concorrentes,
    //    candidatos processados pela ordem fixa de SYMBOLS.
    if (openCount < maxConcurrent) {
      for (const ticker of Object.keys(perSymbolEvents)) {
        if (openCount >= maxConcurrent) break;
        if (positions[ticker]) continue;
        const ev = perSymbolEvents[ticker].get(t);
        if (!ev || !ev.entryOk) continue;
        positions[ticker] = { entryPrice: ev.price, entryTime: new Date(t), qty: NOTIONAL / ev.price, tpTierIndex: 0 };
        openCount++;
      }
    }
  }

  let openMtm = 0;
  const stillOpenTickers = Object.keys(positions);
  for (const ticker of stillOpenTickers) {
    const pos = positions[ticker];
    const lastT = timeline[timeline.length - 1];
    const ev = perSymbolEvents[ticker].get(lastT);
    const lastPrice = ev ? ev.price : pos.entryPrice;
    openMtm += (lastPrice - pos.entryPrice) * pos.qty;
  }

  return { trades, openCount: stillOpenTickers.length, openMtm };
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

  console.log('\nA pré-calcular indicadores por símbolo...');
  const perSymbolEvents = {};
  for (const [ticker, candles] of Object.entries(data)) {
    perSymbolEvents[ticker] = precompute(ticker, candles);
  }

  // Timeline única: união de todos os timestamps de todos os símbolos, ordenada.
  const timeSet = new Set();
  for (const events of Object.values(perSymbolEvents)) {
    for (const t of events.keys()) timeSet.add(t);
  }
  const timeline = Array.from(timeSet).sort((a, b) => a - b);
  console.log(`Timeline: ${timeline.length} velas de ${TIMEFRAME}\n`);

  console.log('════════════════════════════════════════════════════════');
  console.log(`Ema50BandCrossScaleOut V2 + filtro — sweep de limite de posições concorrentes (${DAYS} dias)`);
  console.log('════════════════════════════════════════════════════════');

  const results = MAX_CONCURRENT_CANDIDATES.map(cap => {
    const { trades, openCount, openMtm } = runPortfolio(perSymbolEvents, timeline, cap);
    const s = stats(trades);
    return { cap, ...s, openCount, openMtm, fullPnl: s.totalPnl + openMtm };
  });

  console.table(results.map(r => ({
    limiteConcorrentes: r.cap === Infinity ? 'sem limite' : r.cap,
    trades: r.trades,
    aindaAbertas: r.openCount,
    winRate: r.winRate.toFixed(1) + '%',
    pnlFechados: r.totalPnl.toFixed(2),
    mtmAbertas: r.openMtm.toFixed(2),
    pnlTotal: r.fullPnl.toFixed(2),
    pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
    maxDD: r.maxDD.toFixed(2),
  })));
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
