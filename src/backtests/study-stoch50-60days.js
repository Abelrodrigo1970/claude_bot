// Estudo limpo de 60 dias do Stoch50 sobre as 74 stocks/ETFs, com a config
// real de produção (TP parcial 15%/50%, long-only, sem SL — ver
// src/services/runner.js). Corrige o bug de contas descoberto na validação
// out-of-sample (validate-stoch50-filter-oos.js): o estudo original "de 30
// dias" (study-all-strategies-x-stocks.js) não recortava os trades pela
// data — contava tudo o que estava no array de velas buscado, incluindo o
// buffer de WINDOW(250) velas usado só para aquecer os indicadores, o que
// na prática inflava a janela real para ~40 dias sem avisar. Aqui a mesma
// simulação corre sobre um histórico maior (60 dias + buffer de warmup),
// mas só entram nas estatísticas os trades cuja entrada caiu dentro dos
// últimos 60 dias — janela exata, sem inflação escondida.
//
// Objetivo: com o dobro dos dias da análise anterior (mais poder
// estatístico) e sem o bug de contagem, ver se a lista de stocks
// lucrativas/não-lucrativas fica mais estável do que a instabilidade de
// 44/73 encontrada a comparar duas janelas de 30 dias.
//
// Corre com: node src/backtests/study-stoch50-60days.js
require('dotenv').config();
const ccxt = require('ccxt');
const stoch50 = require('../strategies/stoch50');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL   = 60;
const TAKER_FEE  = 0.00055;
const WINDOW     = 250;
const TIMEFRAME  = '1h';
const STUDY_DAYS = 60;

const TP_PCT = 0.15, TP_CLOSE_FRACTION = 0.5;

const RAW_SYMBOLS = [
  'AAOIUSDT','AAPLUSDT','ADBEUSDT','ALABUSDT','AMATUSDT','AMDSTOCKUSDT',
  'AMZNUSDT','ARMUSDT','ASMLUSDT','ASTSUSDT','AVGOUSDT','AXTIUSDT',
  'BABAUSDT','BBXUSDT','BEUSDT','BMNRUSDT','CBRSUSDT','CIENUSDT',
  'COHRUSDT','COINUSDT','CRCLUSDT','CRDOUSDT','CRWVUSDT','CSCOUSDT',
  'DELLUSDT','DRAMUSDT','EWJUSDT','EWTUSDT','EWYUSDT','FLNCUSDT',
  'GLWUSDT','GOOGLUSDT','HOODUSDT','HPEUSDT','HYUNDAIUSDT','IBMUSDT',
  'INTCUSDT','IRENUSDT','IWMUSDT','KLACUSDT','KORUUSDT','LITEUSDT',
  'LLYUSDT','LRCXUSDT','METAUSDT','MRVLUSDT','MSFTUSDT','MSTRUSDT',
  'MUUSDT','NBISUSDT','NOKIAUSDT','NOWUSDT','NVDAUSDT','ONDSUSDT',
  'ORCLUSDT','PLTRUSDT','QCOMUSDT','QNTXUSDT','QQQUSDT','RKLBUSDT',
  'SAMSUNGUSDT','SKHYNIXUSDT','SMCIUSDT','SNDKUSDT','SOXLUSDT','SPCXUSDT',
  'SPYUSDT','STXXUSDT','TQQQUSDT','TSLAUSDT','TSMUSDT','USARUSDT',
  'UVXYUSDT','WDCUSDT',
];

function toSymbol(raw) {
  const ticker = raw.replace(/USDT$/, '');
  return { ticker, symbol: `${ticker}/USDT:USDT` };
}

function candlesNeeded() {
  return STUDY_DAYS * 24 + WINDOW + 10;
}

async function fetchUniverse(exchange, universe) {
  const total = candlesNeeded();
  const out = {};
  let ok = 0, skipped = [];
  for (const { ticker, symbol } of universe) {
    try {
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total);
      const candles = ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
        time: new Date(time), open, high, low, close, volume,
      }));
      if (candles.length < WINDOW + 30) { skipped.push(ticker); continue; }
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
  const grossPnl = (exitPrice - entryPrice) * qty; // long-only
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  trades.push({ ticker, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag });
}

// Réplica fiel da config de produção: sem SL, TP parcial 50% a 15%, long-only.
function simulate(ticker, candles) {
  const trades = [];
  let pos = null;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;

    if (pos && !pos.tpTaken) {
      const gainPct = (price - pos.entryPrice) / pos.entryPrice;
      if (gainPct >= TP_PCT) {
        const closeQty = pos.qty * TP_CLOSE_FRACTION;
        closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, closeQty, 'tp-parcial');
        pos.qty -= closeQty;
        pos.tpTaken = true;
        if (pos.qty <= 1e-9) { pos = null; continue; }
      }
    }

    const start = Math.max(0, i - WINDOW + 1);
    const window = candles.slice(start, i + 1);
    const { signal } = stoch50.generateSignal(window, pos ? 'long' : null);

    if (signal === 'long' && !pos) {
      pos = { entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, tpTaken: false };
    } else if (signal === 'close_long' && pos) {
      closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'sinal');
      pos = null;
    }
  }
  return trades;
}

function stats(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return { trades: trades.length, wins: wins.length, winRate, totalPnl, pf, pnlPerTrade: trades.length ? totalPnl / trades.length : 0 };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  const universe = RAW_SYMBOLS.map(toSymbol).filter(({ symbol }) => exchange.markets[symbol]);
  console.log(`Universo: ${universe.length} stocks/ETFs\n`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo, ${STUDY_DAYS} dias + buffer de warmup)...`);
  const data = await fetchUniverse(exchange, universe);

  const cutoff = Date.now() - STUDY_DAYS * 24 * 3600 * 1000;
  console.log(`\nJanela exata contabilizada: ${new Date(cutoff).toISOString().slice(0, 10)} → hoje (${STUDY_DAYS} dias, sem o buffer de warmup)\n`);

  const perTicker = {};
  let allTrades = [];
  for (const [ticker, candles] of Object.entries(data)) {
    const trades = simulate(ticker, candles).filter(t => t.entryTime.getTime() >= cutoff);
    perTicker[ticker] = stats(trades);
    allTrades = allTrades.concat(trades);
    process.stdout.write('.');
  }
  console.log('\n');

  const overall = stats(allTrades);
  console.log('════════════════════════════════════════════════════════');
  console.log(`STOCH50 — ${STUDY_DAYS} DIAS, config de produção (TP 15%/50%, long-only), janela exata`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`Total: ${overall.trades} trades, WR ${overall.winRate.toFixed(1)}%, PnL ${overall.totalPnl >= 0 ? '+' : ''}${overall.totalPnl.toFixed(2)} USDT, PF ${overall.pf === Infinity ? '∞' : overall.pf.toFixed(2)}, PnL/trade ${overall.pnlPerTrade.toFixed(3)}\n`);

  const rows = Object.entries(perTicker)
    .map(([ticker, s]) => ({ stock: ticker, trades: s.trades, winRate: s.winRate.toFixed(1) + '%', pnl: s.totalPnl.toFixed(2), pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2), pnlPorTrade: s.pnlPerTrade.toFixed(3) }))
    .sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  console.table(rows);

  const profitable = Object.entries(perTicker).filter(([, s]) => s.totalPnl > 0).map(([t]) => t);
  const losingActual = Object.entries(perTicker).filter(([, s]) => s.totalPnl <= 0).map(([t]) => t);

  function aggFor(list) {
    const present = list.filter(t => perTicker[t]);
    const trades = present.reduce((a, t) => a + perTicker[t].trades, 0);
    const wins = present.reduce((a, t) => a + perTicker[t].wins, 0);
    const totalPnl = present.reduce((a, t) => a + perTicker[t].totalPnl, 0);
    return { stocks: present.length, trades, winRate: trades ? wins / trades * 100 : 0, totalPnl, pnlPerTrade: trades ? totalPnl / trades : 0 };
  }
  const keep = aggFor(profitable);
  const excl = aggFor(losingActual);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('COMPARAÇÃO: lucrativas vs. não-lucrativas nesta janela de 60 dias');
  console.log('════════════════════════════════════════════════════════');
  console.table([
    { grupo: `Lucrativas (${keep.stocks})`, trades: keep.trades, winRate: keep.winRate.toFixed(1) + '%', pnlTotal: keep.totalPnl.toFixed(2), pnlPorTrade: keep.pnlPerTrade.toFixed(3) },
    { grupo: `Não-lucrativas (${excl.stocks})`, trades: excl.trades, winRate: excl.winRate.toFixed(1) + '%', pnlTotal: excl.totalPnl.toFixed(2), pnlPorTrade: excl.pnlPerTrade.toFixed(3) },
  ]);

  console.log(`\nLucrativas (${profitable.length}): ${profitable.join(', ')}`);
  console.log(`\nNão-lucrativas (${losingActual.length}): ${losingActual.join(', ')}`);
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
