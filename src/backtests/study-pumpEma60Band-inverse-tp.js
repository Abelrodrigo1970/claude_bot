// Segue o estudo em study-pumpEma60Band-inverse.js: a versão invertida
// (SHORT em vez de LONG na mesma banda 0-3% acima da EMA60) parecia lucrativa
// (+351.68 USDT incl. abertas), mas o resultado era quase todo PnL NÃO
// realizado — sem TP nem saída própria, 74/74 posições continuavam abertas
// no fim da janela de 15 dias (só saem pelo SL). Este estudo corrige isso:
// adiciona duas saídas reais, sempre ativas,
//   1) Hold máximo de 48h — força o fecho da posição, independente do sinal
//   2) Saída por cruzamento: fecha quando o preço volta a estar <= EMA60
//      (a reversão que a estratégia está a apostar já aconteceu)
// e varre vários níveis de take-profit (0 = desligado, para baseline) para
// ver qual TP maximiza o resultado quando combinado com estas duas saídas.
// SL fixo de 10% mantém-se (mesmo da versão original/inversa).
//
// Corre com: node src/backtests/study-pumpEma60Band-inverse-tp.js [dias]
require('dotenv').config();
const ccxt = require('ccxt');
const pumpEma60Band = require('../strategies/pumpEma60Band');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL   = 60;
const TAKER_FEE  = 0.00055;
const WINDOW     = 250;
const TIMEFRAME  = '15m';
const DAYS       = parseInt(process.argv[2], 10) || 30;
const SL_PCT     = 0.10;
const MAX_HOLD_H = 48;
// Sem isto, a saída "cruzou EMA60" dispara quase sempre 1-2 velas depois da
// entrada (banda de entrada é só 0-3% acima da linha — ruído normal já
// cruza-a de volta quase de imediato), transformando a estratégia em
// scalping de altíssima frequência devorado por comissões. Testado: sem
// filtro, 8187 trades em 30 dias (hold médio 3.6h, -548.89 USDT apesar de
// 57% WR); só com hold mínimo de 1h, ainda 6733 trades (98.5% saem por
// "cruzou EMA60", hold médio 4.6h) — o hold mínimo sozinho não chega,
// porque o preço toca a linha por ruído mesmo passada 1h. Junta-se agora
// uma margem real de rutura (fecho pelo menos 0.5% abaixo da EMA60, não só
// tocar-lhe) + hold mínimo maior, para a saída representar uma reversão a
// sério em vez de ruído em torno da linha.
const MIN_HOLD_H_FOR_CROSS_EXIT = 2;
const CROSS_EXIT_MARGIN_PCT = 0.5; // % mínimo abaixo da EMA60 para contar como rutura confirmada

const TP_CANDIDATES = [0, 0.02, 0.03, 0.05, 0.08, 0.10, 0.15, 0.20];

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

// Mesmo gatilho de entrada do estudo anterior (banda 0-3% acima da EMA60),
// SHORT em vez de LONG. Pré-calcula os indicadores (ema60/distPct) uma vez
// por símbolo em vez de recalcular a cada vela (o sweep corre 8 configs de
// TP sobre os mesmos dados — não vale a pena repetir o EMA.calculate 8x).
function precomputeSeries(candles) {
  const { EMA } = require('technicalindicators');
  const closes = candles.map(c => c.close);
  const ema60Arr = EMA.calculate({ period: 60, values: closes });
  // alinha ema60Arr (começa no índice 59) com o índice de candles
  const ema60ByIdx = new Array(candles.length).fill(null);
  for (let j = 0; j < ema60Arr.length; j++) ema60ByIdx[j + 59] = ema60Arr[j];
  return candles.map((c, i) => {
    const ema60 = ema60ByIdx[i];
    const distPct = ema60 != null ? ((c.close - ema60) / ema60) * 100 : null;
    return { ...c, ema60, distPct, inLongBand: distPct != null && distPct > 0 && distPct < 3 };
  });
}

function closeTrade(trades, ticker, side, entryPrice, entryTime, exitPrice, exitTime, qty, tag) {
  const grossPnl = side === 'long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ ticker, side, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag });
}

// Simula a versão invertida (short-only) com 4 saídas possíveis, por ordem
// de verificação: SL fixo (10%) > TP (se cfg.tpPct>0) > hold máximo (48h) >
// cruzamento de volta para <= EMA60. A primeira que disparar fecha a posição.
function simulate(series, ticker, tpPct) {
  const trades = [];
  let pos = null; // { entryPrice, entryTime, qty }

  for (let i = 65; i < series.length; i++) {
    const bar = series[i];
    if (bar.ema60 == null) continue;
    const price = bar.close;

    if (pos) {
      const lossPct = (price - pos.entryPrice) / pos.entryPrice;
      const gainPct = (pos.entryPrice - price) / pos.entryPrice;
      const heldH = (bar.time - pos.entryTime) / 3.6e6;

      if (lossPct >= SL_PCT) {
        closeTrade(trades, ticker, 'short', pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'stop-loss');
        pos = null;
      } else if (tpPct > 0 && gainPct >= tpPct) {
        closeTrade(trades, ticker, 'short', pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'take-profit');
        pos = null;
      } else if (heldH >= MAX_HOLD_H) {
        closeTrade(trades, ticker, 'short', pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'hold-maximo');
        pos = null;
      } else if (heldH >= MIN_HOLD_H_FOR_CROSS_EXIT && price <= bar.ema60 * (1 - CROSS_EXIT_MARGIN_PCT / 100)) {
        closeTrade(trades, ticker, 'short', pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'cruzou-ema60');
        pos = null;
      }
      continue; // posição existia ao início da vela — não reavalia entrada na mesma vela
    }

    if (bar.inLongBand) {
      pos = { entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price };
    }
  }

  let openMtmPnl = 0;
  if (pos) {
    const lastPrice = series[series.length - 1].close;
    openMtmPnl = (pos.entryPrice - lastPrice) * pos.qty;
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
  const avgHoldH = trades.length ? trades.reduce((a, t) => a + (t.exitTime - t.entryTime) / 3.6e6, 0) / trades.length : 0;
  const byTag = {};
  trades.forEach(t => { byTag[t.tag] = (byTag[t.tag] || 0) + 1; });
  return { trades: trades.length, wins: wins.length, losses: losses.length, winRate, totalPnl, pf, maxDD, avgHoldH, byTag };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  const universe = RAW_SYMBOLS.map(toSymbol).filter(({ symbol }) => exchange.markets[symbol]);
  console.log(`Universo: ${universe.length} stocks/ETFs\n`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo, ${DAYS} dias)...`);
  const data = await fetchUniverse(exchange, universe);

  console.log('\nA pré-calcular EMA60 por símbolo...');
  const seriesByTicker = {};
  for (const [ticker, candles] of Object.entries(data)) seriesByTicker[ticker] = precomputeSeries(candles);

  console.log(`\nSaídas ativas: SL fixo ${(SL_PCT * 100).toFixed(0)}% · hold máximo ${MAX_HOLD_H}h · cruzamento de volta <= EMA60 · TP variável (sweep)\n`);

  const results = [];
  for (const tpPct of TP_CANDIDATES) {
    let allTrades = [];
    let openMtm = 0, openCount = 0;
    for (const [ticker, series] of Object.entries(seriesByTicker)) {
      const { trades, stillOpen, openMtmPnl } = simulate(series, ticker, tpPct);
      allTrades = allTrades.concat(trades);
      openMtm += openMtmPnl;
      if (stillOpen) openCount++;
    }
    const s = stats(allTrades);
    results.push({
      label: tpPct === 0 ? 'Sem TP (baseline)' : `TP ${(tpPct * 100).toFixed(0)}%`,
      tpPct, ...s, openMtm, openCount, fullPnl: s.totalPnl + openMtm,
    });
    process.stdout.write('.');
  }
  console.log('\n');

  console.log('════════════════════════════════════════════════════════');
  console.log(`SWEEP DE TAKE-PROFIT — PumpEma60Band INVERSA (short), SL ${(SL_PCT * 100).toFixed(0)}%, hold máx ${MAX_HOLD_H}h, saída em <=EMA60, ${DAYS} dias`);
  console.log('════════════════════════════════════════════════════════');
  console.table(results.map(r => ({
    config: r.label,
    trades: r.trades,
    aindaAbertas: r.openCount,
    winRate: r.winRate.toFixed(1) + '%',
    pnlFechados: r.totalPnl.toFixed(2),
    mtmAbertas: r.openMtm.toFixed(2),
    pnlTotal: r.fullPnl.toFixed(2),
    pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
    maxDD: r.maxDD.toFixed(2),
    holdMedioH: r.avgHoldH.toFixed(1),
  })));

  const best = results.slice().sort((a, b) => b.fullPnl - a.fullPnl)[0];
  console.log(`\nMelhor config por PnL total (incl. abertas): ${best.label} → ${best.fullPnl >= 0 ? '+' : ''}${best.fullPnl.toFixed(2)} USDT (PF ${best.pf === Infinity ? '∞' : best.pf.toFixed(2)}, WR ${best.winRate.toFixed(1)}%, ${best.trades} trades fechados, ${best.openCount} ainda abertas)`);

  const bestClosedOnly = results.slice().sort((a, b) => b.totalPnl - a.totalPnl)[0];
  console.log(`Melhor config só por trades FECHADOS (resultado já realizado, mais fiável): ${bestClosedOnly.label} → ${bestClosedOnly.totalPnl >= 0 ? '+' : ''}${bestClosedOnly.totalPnl.toFixed(2)} USDT`);

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`DISTRIBUIÇÃO DOS MOTIVOS DE SAÍDA por config`);
  console.log('════════════════════════════════════════════════════════');
  console.table(results.map(r => ({
    config: r.label,
    'stop-loss': r.byTag['stop-loss'] || 0,
    'take-profit': r.byTag['take-profit'] || 0,
    'hold-maximo': r.byTag['hold-maximo'] || 0,
    'cruzou-ema60': r.byTag['cruzou-ema60'] || 0,
  })));
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
