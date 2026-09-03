// PumpEma60Band foi a pior estratégia do estudo geral sobre stocks
// (src/backtests/study-all-strategies-x-stocks.js): 0% win rate em todos os
// 45 stocks onde entrou, -466.36 USDT agregado. Desenho original: LONG-only,
// entra quando o preço está 0-3% acima da EMA60 (banda), sem sinal de saída
// próprio — só sai pelo SL fixo de 10% (ver src/strategies/pumpEma60Band.js).
// Em stocks (mais lentos, sem os pumps verticais de cripto que validaram
// esta regra) essa banda parece estar a comprar o topo em vez do início da
// subida, daí o SL bater sempre.
//
// Este estudo testa o oposto: mesmo gatilho de entrada (banda 0-3% acima da
// EMA60), mas SHORT em vez de LONG — "fade" a mesma banda em vez de a
// seguir. Mesma gestão de posição (SL fixo 10%, sem TP nem trailing, sem
// saída por sinal) para isolar só o efeito de inverter o lado. Compara
// lado a lado com a versão original (LONG) sobre o mesmo universo/período.
//
// Corre com: node src/backtests/study-pumpEma60Band-inverse.js
require('dotenv').config();
const ccxt = require('ccxt');
const pumpEma60Band = require('../strategies/pumpEma60Band');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL  = 60;
const TAKER_FEE = 0.00055;
const WINDOW    = 250;
const TIMEFRAME = '15m';
const DAYS      = 15;
const SL_PCT    = 0.10;

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

// Mesmo gatilho (banda 0-3% acima da EMA60), lado invertido: SHORT em vez
// de LONG. Short-only, sem sinal de saída próprio — só sai pelo SL fixo,
// espelhando exatamente o desenho original.
function generateSignalInverse(candles, currentPosition = null) {
  if (candles.length < 65) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 65)', indicators: {} };
  }
  const ind = pumpEma60Band.calculateIndicators(candles);
  const base = `preço ${ind.distPct >= 0 ? '+' : ''}${ind.distPct.toFixed(2)}% vs EMA60=${ind.ema60.toFixed(6)}`;

  if (!currentPosition) {
    if (ind.inLongBand) {
      return { signal: 'short', reason: `${base} · dentro da banda 0-3% — INVERTIDA: entra short (fade)`, indicators: ind };
    }
    return { signal: 'hold', reason: `${base} · fora da banda de entrada`, indicators: ind };
  }
  return { signal: 'hold', reason: `${base} · mantém short (só sai por SL)`, indicators: ind };
}

function candlesNeeded() {
  const barsPerDay = (24 * 60) / 15;
  return Math.round(DAYS * barsPerDay) + WINDOW + 10;
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

function simulate(generateSignal, ticker, candles) {
  const trades = [];
  let pos = null;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;

    if (pos) {
      const lossPct = pos.side === 'long' ? (pos.entryPrice - price) / pos.entryPrice : (price - pos.entryPrice) / pos.entryPrice;
      if (lossPct >= SL_PCT) {
        closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'stop-loss');
        pos = null;
        continue;
      }
    }

    const start = Math.max(0, i - WINDOW + 1);
    const window = candles.slice(start, i + 1);
    const { signal } = generateSignal(window, pos?.side ?? null);

    if ((signal === 'long' || signal === 'short') && !pos) {
      pos = { side: signal, entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price };
    } else if ((signal === 'close_long' || signal === 'close_short') && pos) {
      closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'sinal');
      pos = null;
    }
  }
  // Marca a mercado a posição ainda aberta no fim da janela (última vela) —
  // sem isto, uma comparação só por trades FECHADOS penaliza injustamente a
  // versão que simplesmente ainda não bateu no seu próprio SL (ver nota no
  // topo do ficheiro: a inversa tende a ficar "presa" em lucro flutuante
  // por não ter saída por sinal, só SL).
  let openMtmPnl = 0;
  if (pos) {
    const lastPrice = candles[candles.length - 1].close;
    openMtmPnl = pos.side === 'long' ? (lastPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - lastPrice) * pos.qty;
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
  return { trades: trades.length, wins: wins.length, losses: losses.length, winRate, totalPnl, pf, maxDD };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  const universe = RAW_SYMBOLS.map(toSymbol).filter(({ symbol }) => exchange.markets[symbol]);
  console.log(`Universo: ${universe.length} stocks/ETFs\n`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo, ${DAYS} dias)...`);
  const data = await fetchUniverse(exchange, universe);

  const perStock = [];
  let origAgg = [], invAgg = [];
  let origOpenMtm = 0, invOpenMtm = 0, origOpenCount = 0, invOpenCount = 0;

  for (const [ticker, candles] of Object.entries(data)) {
    const orig = simulate(pumpEma60Band.generateSignal, ticker, candles);
    const inv  = simulate(generateSignalInverse, ticker, candles);
    origAgg = origAgg.concat(orig.trades);
    invAgg  = invAgg.concat(inv.trades);
    origOpenMtm += orig.openMtmPnl; invOpenMtm += inv.openMtmPnl;
    if (orig.stillOpen) origOpenCount++;
    if (inv.stillOpen) invOpenCount++;
    const so = stats(orig.trades);
    const si = stats(inv.trades);
    const soFull = so.totalPnl + orig.openMtmPnl;
    const siFull = si.totalPnl + inv.openMtmPnl;
    perStock.push({
      stock: ticker,
      origTrades: so.trades, origPnl: so.totalPnl, origWR: so.winRate, origOpenMtm: orig.openMtmPnl, origFull: soFull,
      invTrades: si.trades, invPnl: si.totalPnl, invWR: si.winRate, invOpenMtm: inv.openMtmPnl, invFull: siFull,
      melhor: siFull > soFull ? 'INVERSA' : (soFull > siFull ? 'ORIGINAL' : '='),
    });
  }

  const so = stats(origAgg);
  const si = stats(invAgg);

  console.log('\n════════════════════════════════════════════════');
  console.log('COMPARAÇÃO AGREGADA — PumpEma60Band ORIGINAL (long) vs INVERSA (short)');
  console.log('(PnL fechados = só trades já saídos pelo SL · PnL c/ abertas = inclui posições ainda');
  console.log(' abertas no fim da janela, marcadas a mercado no último preço — comparação justa,');
  console.log(' já que a inversa não tem saída por sinal, só sai pelo próprio SL)');
  console.log('════════════════════════════════════════════════');
  console.table([
    { versao: 'ORIGINAL (long)', trades: so.trades, aindaAbertas: origOpenCount, winRate: so.winRate.toFixed(1) + '%', pnlFechados: so.totalPnl.toFixed(2), mtmAbertas: origOpenMtm.toFixed(2), pnlComAbertas: (so.totalPnl + origOpenMtm).toFixed(2), pf: so.pf === Infinity ? '∞' : so.pf.toFixed(2), maxDD: so.maxDD.toFixed(2) },
    { versao: 'INVERSA (short)', trades: si.trades, aindaAbertas: invOpenCount, winRate: si.winRate.toFixed(1) + '%', pnlFechados: si.totalPnl.toFixed(2), mtmAbertas: invOpenMtm.toFixed(2), pnlComAbertas: (si.totalPnl + invOpenMtm).toFixed(2), pf: si.pf === Infinity ? '∞' : si.pf.toFixed(2), maxDD: si.maxDD.toFixed(2) },
  ]);

  perStock.sort((a, b) => b.invFull - a.invFull);
  console.log('\n════════════════════════════════════════════════');
  console.log('POR STOCK — ordenado por PnL da versão INVERSA (short), incl. abertas (MtM)');
  console.log('════════════════════════════════════════════════');
  console.table(perStock.map(s => ({
    stock: s.stock,
    trades_orig: s.origTrades, pnl_orig_fech: s.origPnl.toFixed(2), mtm_orig: s.origOpenMtm.toFixed(2), pnl_orig_full: s.origFull.toFixed(2),
    trades_inv: s.invTrades, pnl_inv_fech: s.invPnl.toFixed(2), mtm_inv: s.invOpenMtm.toFixed(2), pnl_inv_full: s.invFull.toFixed(2),
    melhor: s.melhor,
  })));

  const invWins = perStock.filter(s => s.melhor === 'INVERSA').length;
  const origWins = perStock.filter(s => s.melhor === 'ORIGINAL').length;
  console.log(`\nInversa melhor em ${invWins}/${perStock.length} stocks · Original melhor em ${origWins}/${perStock.length} stocks`);
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
