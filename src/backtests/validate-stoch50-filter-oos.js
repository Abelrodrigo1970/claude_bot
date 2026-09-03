// Validação out-of-sample do filtro symbolExclude do Stoch50 (ver
// src/services/runner.js) — o filtro (20 símbolos excluídos, 53 mantidos)
// foi derivado do estudo em study-all-strategies-x-stocks.js sobre os
// ÚLTIMOS 30 dias (mesma config: TP parcial 15%/50%/long-only, sem SL).
// Isso é IN-SAMPLE — a lista foi escolhida a olhar para os próprios dados
// que a validam, risco real de overfitting.
//
// Este script corre a MESMA config sobre uma janela mais antiga e sem
// sobreposição (dias 31-60 atrás, "OOS") e compara os dois grupos (mantidos
// vs. excluídos) nesse período que a lista NUNCA viu. Se o grupo "mantidos"
// continuar melhor que o "excluídos" fora da amostra, o filtro tem alguma
// generalização real; se a diferença desaparecer ou inverter, é overfitting.
//
// Corre com: node src/backtests/validate-stoch50-filter-oos.js
require('dotenv').config();
const ccxt = require('ccxt');
const stoch50 = require('../strategies/stoch50');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL   = 60;
const TAKER_FEE  = 0.00055;
const WINDOW     = 250;
const TIMEFRAME  = '1h';
const IS_DAYS    = 30;   // janela que gerou o filtro (mais recente)
const OOS_DAYS   = 30;   // janela out-of-sample, imediatamente anterior, sem sobreposição
const TOTAL_DAYS = IS_DAYS + OOS_DAYS;

const TP_PCT = 0.15, TP_CLOSE_FRACTION = 0.5, TP_SIDE = 'long';

const KEEP_LIST = [
  'NBIS','KORU','IREN','SPCX','SOXL','MRVL','SNDK','ALAB','LITE','CRDO','CRWV','AXTI','GLW',
  'SMCI','PLTR','SKHYNIX','COHR','USAR','AMZN','NOW','LRCX','EWT','TQQQ','CIEN','DRAM','BE',
  'HYUNDAI','SAMSUNG','NOKIA','BMNR','EWY','DELL','ADBE','ASTS','MSFT','MU','LLY','HPE','ORCL',
  'NVDA','ARM','QNTX','QCOM','TSM','TSLA','COIN','HOOD','AAOI','QQQ','AAPL','EWJ','INTC','GOOGL',
];
const EXCLUDE_LIST = [
  'UVXY','AVGO','FLNC','KLAC','IBM','CBRS','BBX','META','ONDS','MSTR',
  'AMAT','ASML','CRCL','IWM','STXX','CSCO','BABA','WDC','SPY','AMDSTOCK',
];

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
  return TOTAL_DAYS * 24 + WINDOW + 10;
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

function closeTrade(trades, ticker, side, entryPrice, entryTime, exitPrice, exitTime, qty, tag) {
  const grossPnl = side === 'long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ ticker, side, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag });
}

// Réplica fiel da config de produção do Stoch50: sem SL, TP parcial 50% a
// 15% só do lado long (a estratégia é long-only — ver stoch50.js).
function simulate(ticker, candles) {
  const trades = [];
  let pos = null; // { side, entryPrice, entryTime, qty, tpTaken }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;

    if (pos && !pos.tpTaken) {
      const gainPct = (price - pos.entryPrice) / pos.entryPrice; // long-only
      if (gainPct >= TP_PCT) {
        const closeQty = pos.qty * TP_CLOSE_FRACTION;
        closeTrade(trades, ticker, 'long', pos.entryPrice, pos.entryTime, price, bar.time, closeQty, 'tp-parcial');
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
      closeTrade(trades, ticker, 'long', pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'sinal');
      pos = null;
    }
  }
  return trades;
}

function stats(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  return { trades: trades.length, wins: wins.length, winRate, totalPnl, pnlPerTrade: trades.length ? totalPnl / trades.length : 0 };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  const universe = RAW_SYMBOLS.map(toSymbol).filter(({ symbol }) => exchange.markets[symbol]);
  console.log(`Universo: ${universe.length} stocks/ETFs\n`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo, ${TOTAL_DAYS} dias — ${IS_DAYS}d IS + ${OOS_DAYS}d OOS)...`);
  const data = await fetchUniverse(exchange, universe);

  const now = Date.now();
  const isStart  = now - IS_DAYS * 24 * 3600 * 1000;
  const oosStart = now - TOTAL_DAYS * 24 * 3600 * 1000;

  console.log(`\nJanela IS  (in-sample, já vista pelo filtro):  ${new Date(isStart).toISOString().slice(0,10)} → hoje`);
  console.log(`Janela OOS (out-of-sample, nunca vista):        ${new Date(oosStart).toISOString().slice(0,10)} → ${new Date(isStart).toISOString().slice(0,10)}\n`);

  const perTickerIS = {}, perTickerOOS = {};
  for (const [ticker, candles] of Object.entries(data)) {
    const trades = simulate(ticker, candles);
    const isT  = trades.filter(t => t.entryTime.getTime() >= isStart);
    const oosT = trades.filter(t => t.entryTime.getTime() >= oosStart && t.entryTime.getTime() < isStart);
    perTickerIS[ticker]  = stats(isT);
    perTickerOOS[ticker] = stats(oosT);
    process.stdout.write('.');
  }
  console.log('\n');

  function aggFor(list, perTicker) {
    const present = list.filter(t => perTicker[t]);
    const trades = present.reduce((a, t) => a + perTicker[t].trades, 0);
    const wins = present.reduce((a, t) => a + perTicker[t].wins, 0);
    const totalPnl = present.reduce((a, t) => a + perTicker[t].totalPnl, 0);
    return {
      stocks: present.length, trades, winRate: trades ? (wins / trades * 100) : 0,
      totalPnl, pnlPerTrade: trades ? totalPnl / trades : 0,
    };
  }

  const keepIS   = aggFor(KEEP_LIST, perTickerIS);
  const exclIS   = aggFor(EXCLUDE_LIST, perTickerIS);
  const keepOOS  = aggFor(KEEP_LIST, perTickerOOS);
  const exclOOS  = aggFor(EXCLUDE_LIST, perTickerOOS);

  console.log('════════════════════════════════════════════════════════');
  console.log('VALIDAÇÃO OUT-OF-SAMPLE DO FILTRO symbolExclude — Stoch50');
  console.log('(config real de produção: TP parcial 15%/50%, long-only, sem SL)');
  console.log('════════════════════════════════════════════════════════');
  console.table([
    { grupo: 'MANTIDOS (53) — janela IS (recalculada)',  stocks: keepIS.stocks,  trades: keepIS.trades,  winRate: keepIS.winRate.toFixed(1) + '%',  pnlTotal: keepIS.totalPnl.toFixed(2),  pnlPorTrade: keepIS.pnlPerTrade.toFixed(3) },
    { grupo: 'EXCLUÍDOS (20) — janela IS (recalculada)', stocks: exclIS.stocks, trades: exclIS.trades, winRate: exclIS.winRate.toFixed(1) + '%', pnlTotal: exclIS.totalPnl.toFixed(2), pnlPorTrade: exclIS.pnlPerTrade.toFixed(3) },
    { grupo: '─────────────────────────────', stocks: '', trades: '', winRate: '', pnlTotal: '', pnlPorTrade: '' },
    { grupo: 'MANTIDOS (53) — janela OOS (nunca vista)',  stocks: keepOOS.stocks,  trades: keepOOS.trades,  winRate: keepOOS.winRate.toFixed(1) + '%',  pnlTotal: keepOOS.totalPnl.toFixed(2),  pnlPorTrade: keepOOS.pnlPerTrade.toFixed(3) },
    { grupo: 'EXCLUÍDOS (20) — janela OOS (nunca vista)', stocks: exclOOS.stocks, trades: exclOOS.trades, winRate: exclOOS.winRate.toFixed(1) + '%', pnlTotal: exclOOS.totalPnl.toFixed(2), pnlPorTrade: exclOOS.pnlPerTrade.toFixed(3) },
  ]);

  const holds = keepOOS.pnlPerTrade > exclOOS.pnlPerTrade;
  console.log(`\n${holds ? '✅ O filtro GENERALIZA' : '❌ O filtro NÃO generaliza'} fora da amostra: mantidos ${keepOOS.pnlPerTrade >= 0 ? '+' : ''}${keepOOS.pnlPerTrade.toFixed(3)} USDT/trade vs. excluídos ${exclOOS.pnlPerTrade >= 0 ? '+' : ''}${exclOOS.pnlPerTrade.toFixed(3)} USDT/trade na janela OOS.`);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('DETALHE POR STOCK — janela OOS (para ver quem inverteu)');
  console.log('════════════════════════════════════════════════════════');
  const rows = [...KEEP_LIST.map(t => ({ t, grupo: 'mantido' })), ...EXCLUDE_LIST.map(t => ({ t, grupo: 'excluído' }))]
    .filter(({ t }) => perTickerOOS[t])
    .map(({ t, grupo }) => ({
      stock: t, grupo,
      pnl_IS: perTickerIS[t].totalPnl.toFixed(2),
      pnl_OOS: perTickerOOS[t].totalPnl.toFixed(2),
      trades_OOS: perTickerOOS[t].trades,
      inverteu: (perTickerIS[t].totalPnl > 0) !== (perTickerOOS[t].totalPnl > 0) ? 'SIM' : '',
    }))
    .sort((a, b) => parseFloat(b.pnl_OOS) - parseFloat(a.pnl_OOS));
  console.table(rows);

  const flipped = rows.filter(r => r.inverteu === 'SIM').length;
  console.log(`\n${flipped}/${rows.length} stocks inverteram de sinal (lucrativo↔não-lucrativo) entre IS e OOS.`);
}

main().catch(err => { console.error('Erro na validação:', err); process.exit(1); });
