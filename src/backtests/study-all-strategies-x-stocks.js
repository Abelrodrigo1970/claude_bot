// Estudo completo: corre TODAS as estratégias sobre TODA a lista de
// stocks/ETFs (mesma lista do src/db/seed-stocks.js) e reporta qual
// estratégia funciona melhor em cada stock.
//
// Reutiliza os módulos reais em src/strategies/*.js (mesma generateSignal
// usada em produção pelo runner.js) — não reimplementa a lógica de entrada/
// saída. Reproduz também as regras de gestão de posição do runner.js
// (stop-loss fixo por lado, trailing stop a partir do lucro, take-profit
// parcial) usando os mesmos parâmetros configurados em STRATEGIES lá,
// exceto a lista de símbolos: aqui corre-se sempre o universo completo de
// stocks, para descobrir por stock qual estratégia tem edge (em vez de usar
// as listas/exclusões já curadas por estudos anteriores).
//
// EMA90TopFade precisa de um "rank" (posição no ranking de % acima da
// EMA90 diária) que em produção vem do scanner sobre TODO o mercado cripto.
// Aqui recalcula-se o rank equivalente mas restrito ao próprio universo de
// stocks (mesma fórmula do scanner.js: só entram no ranking os símbolos com
// close > EMA90, ordenados por %acima desc) — é a adaptação mais fiel
// possível para "top 8 mais esticados" dentro deste universo. O filtro QQQ
// usa o próprio QQQ/USDT:USDT, que já faz parte da lista de stocks.
//
// Corre com: node src/backtests/study-all-strategies-x-stocks.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const trendSurfer       = require('../strategies/trendSurfer');
const stockSMA          = require('../strategies/stockSMA');
const stoch50            = require('../strategies/stoch50');
const stockEma1270Cross = require('../strategies/stockEma1270Cross');
const pullbackTrend     = require('../strategies/pullbackTrend');
const pumpEmaSpread     = require('../strategies/pumpEmaSpread');
const pumpTrendFlip     = require('../strategies/pumpTrendFlip');
const pumpEma60Band     = require('../strategies/pumpEma60Band');
const ema90TopFade      = require('../strategies/ema90TopFade');
const stochRsiTop4Flip  = require('../strategies/stochRsiTop4Flip');

const NOTIONAL   = 60;
const TAKER_FEE  = 0.00055;
const MIN_TRADES = 3; // mínimo de trades fechados para uma estratégia contar como "válida" num stock

// Mesma lista usada em src/db/seed-stocks.js
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

// Dias de janela de trading (+ buffer de warm-up de 260 velas, igual ao
// tamanho de janela usado a cada avaliação — ver WINDOW abaixo) por timeframe.
const WINDOW = 250; // candles passadas a cada generateSignal (igual ao bybit.getCandles(...,250) do runner.js)
// Os tokens de stocks/ETFs na Bybit são produtos recentes (listados há
// ~130 dias em relação à data deste estudo) — não há histórico diário
// suficiente para 200 dias + buffer. TF_DAYS['1d'] pede o máximo razoável;
// fetchOHLCVPaginated devolve o que existir (menos do que isto, sem erro).
const TF_DAYS = { '1h': 30, '2h': 30, '5m': 7, '15m': 15, '1d': 130 };
const TF_MS = { '5m': 5, '15m': 15, '1h': 60, '2h': 120, '1d': 1440 };

// Mínimo de velas para um símbolo entrar no estudo num timeframe. Diário
// fica à parte: só há ~130 velas disponíveis no total (histórico curto do
// produto), e a EMA90 (usada no ranking do EMA90TopFade) só existe a partir
// da vela 90 — exige-se só warm-up da EMA90 + uma margem mínima de dias
// para haver sinal, em vez do buffer geral (WINDOW+30) usado nos outros
// timeframes.
const MIN_CANDLES_BY_TF = { '1d': 100 };
function minCandlesFor(tf) { return MIN_CANDLES_BY_TF[tf] ?? (WINDOW + 30); }

function candlesNeeded(tf) {
  const days = TF_DAYS[tf];
  const barsPerDay = (24 * 60) / TF_MS[tf];
  return Math.round(days * barsPerDay) + WINDOW + 10;
}

// Config das estratégias — timeframe e parâmetros de gestão de posição
// espelham src/services/runner.js (STRATEGIES) onde a estratégia lá está
// registada; onde não está (PullbackTrend, StochRSITop4Flip), usa os
// valores documentados no próprio ficheiro da estratégia como saída pura
// por sinal (sem SL/TP fixo) ou os SL comentados no código (StochRSITop4Flip).
const STRATS = [
  { key: 'TrendSurfer',       mod: trendSurfer,       timeframe: '1h' },
  { key: 'StockSMA',          mod: stockSMA,          timeframe: '2h', stopLossPct: 0.05 },
  { key: 'Stoch50',           mod: stoch50,           timeframe: '1h', takeProfitPct: 0.15, takeProfitCloseFraction: 0.5, takeProfitSide: 'long' },
  { key: 'StockEma1270Cross', mod: stockEma1270Cross, timeframe: '1h', takeProfitPct: 0.19, takeProfitCloseFraction: 0.5 },
  { key: 'PullbackTrend',     mod: pullbackTrend,     timeframe: '1h' },
  { key: 'PumpEmaSpread',     mod: pumpEmaSpread,     timeframe: '5m', trailingStopPct: 0.10 },
  { key: 'PumpTrendFlip',     mod: pumpTrendFlip,     timeframe: '1h', trailingStopPct: 0.10 },
  { key: 'PumpEma60Band',     mod: pumpEma60Band,     timeframe: '15m', stopLossPct: 0.10 },
  { key: 'EMA90TopFade',      mod: ema90TopFade,      timeframe: '1d', stopLossPct: 0.26, needsRank: true, needsQqq: true },
  { key: 'StochRSITop4Flip',  mod: stochRsiTop4Flip,  timeframe: '1h', stopLossLongPct: 0.05, stopLossShortPct: 0.07 },
];

function dateStr(d) { return d.toISOString().slice(0, 10); }

async function fetchUniverse(exchange, universe, timeframe) {
  const total = candlesNeeded(timeframe);
  const out = {};
  let ok = 0, skipped = [];
  for (const { ticker, symbol } of universe) {
    try {
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, timeframe, total);
      const candles = ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
        time: new Date(time), open, high, low, close, volume,
      }));
      if (candles.length < minCandlesFor(timeframe)) { skipped.push(ticker); continue; }
      out[ticker] = candles;
      ok++;
      process.stdout.write('.');
    } catch (err) {
      skipped.push(ticker);
      process.stdout.write('x');
    }
  }
  console.log(`\n  [${timeframe}] ${ok} ok, ${skipped.length} ignorados${skipped.length ? ' (' + skipped.join(',') + ')' : ''}`);
  return out;
}

// Ranking EMA90 diário por dia, restrito ao universo de stocks — mesma
// fórmula do scanner.js (só entram símbolos com close>EMA90, ordenados por
// %acima desc). Também devolve o regime QQQ (close hoje >= close ontem).
function computeDailyContext(dailyBySymbol) {
  if (!Object.keys(dailyBySymbol).length) {
    console.warn('  Sem dados diários suficientes para nenhum símbolo — EMA90TopFade ficará sem rank (sempre hold).');
    return { rankByDate: {}, qqqPositiveByDate: {} };
  }
  const EMA_PERIOD = 90;
  const emaBySymbol = {};
  for (const [ticker, candles] of Object.entries(dailyBySymbol)) {
    const closes = candles.map(c => c.close);
    emaBySymbol[ticker] = EMA.calculate({ period: EMA_PERIOD, values: closes });
  }

  // Índice de referência: usa o símbolo com mais velas diárias como calendário
  const refTicker = Object.entries(dailyBySymbol).sort((a, b) => b[1].length - a[1].length)[0][0];
  const refDates = dailyBySymbol[refTicker].map(c => c.time);

  const rankByDate = {}; // dateStr -> { ticker: rank }
  const qqqPositiveByDate = {};

  for (let di = 0; di < refDates.length; di++) {
    const ds = dateStr(refDates[di]);
    const rows = [];
    for (const [ticker, candles] of Object.entries(dailyBySymbol)) {
      const idx = candles.findIndex(c => c.time.getTime() === refDates[di].getTime());
      if (idx < 0) continue;
      const emaArr = emaBySymbol[ticker];
      const emaIdx = idx - (EMA_PERIOD - 1);
      if (emaIdx < 0 || emaIdx >= emaArr.length) continue;
      const ema = emaArr[emaIdx];
      const close = candles[idx].close;
      if (close > ema) rows.push({ ticker, pctAbove: ((close - ema) / ema) * 100 });

      if (ticker === 'QQQ' && idx > 0) {
        qqqPositiveByDate[ds] = close >= candles[idx - 1].close;
      }
    }
    rows.sort((a, b) => b.pctAbove - a.pctAbove);
    const map = {};
    rows.forEach((r, i) => { map[r.ticker] = i + 1; });
    rankByDate[ds] = map;
  }

  return { rankByDate, qqqPositiveByDate };
}

function closeTrade(trades, ticker, side, entryPrice, entryTime, exitPrice, exitTime, qty, tag) {
  const grossPnl = side === 'long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = side === 'long' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ ticker, side, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag });
}

function slPctFor(cfg, side) {
  if (side === 'long' && cfg.stopLossLongPct != null) return cfg.stopLossLongPct;
  if (side === 'short' && cfg.stopLossShortPct != null) return cfg.stopLossShortPct;
  return cfg.stopLossPct;
}

function simulateStrategy(cfg, ticker, candles, dailyCtx) {
  const trades = [];
  let pos = null; // { side, entryPrice, entryTime, qty, extremePrice, trailActive, tpTaken }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;

    // 1) Take-profit parcial (não fecha o loop, só reduz a posição)
    if (cfg.takeProfitPct && pos && !pos.tpTaken && (!cfg.takeProfitSide || pos.side === cfg.takeProfitSide)) {
      const pnlPct = pos.side === 'long' ? (price - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - price) / pos.entryPrice;
      if (pnlPct >= cfg.takeProfitPct) {
        const closeQty = pos.qty * cfg.takeProfitCloseFraction;
        closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, closeQty, 'tp-parcial');
        pos.qty -= closeQty;
        pos.tpTaken = true;
        if (pos.qty <= 1e-9) { pos = null; continue; }
      }
    }

    // 2) Stop-loss fixo — fecha tudo e salta para a próxima vela
    if (pos) {
      const slPct = slPctFor(cfg, pos.side);
      if (slPct) {
        const lossPct = pos.side === 'long' ? (pos.entryPrice - price) / pos.entryPrice : (price - pos.entryPrice) / pos.entryPrice;
        if (lossPct >= slPct) {
          closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'stop-loss');
          pos = null;
          continue;
        }
      }
    }

    // 3) Trailing stop (ativa só depois de entrar em lucro)
    if (pos && cfg.trailingStopPct) {
      if (!pos.trailActive) {
        const inProfit = pos.side === 'long' ? price > pos.entryPrice : price < pos.entryPrice;
        if (inProfit) pos.trailActive = true;
      }
      if (pos.trailActive) {
        pos.extremePrice = pos.side === 'long' ? Math.max(pos.extremePrice, price) : Math.min(pos.extremePrice, price);
        const trailPrice = pos.side === 'long' ? pos.extremePrice * (1 - cfg.trailingStopPct) : pos.extremePrice * (1 + cfg.trailingStopPct);
        const hit = pos.side === 'long' ? price <= trailPrice : price >= trailPrice;
        if (hit) {
          closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'trailing-stop');
          pos = null;
          continue;
        }
      }
    }

    // 4) Sinal da estratégia (janela de WINDOW velas, igual ao runner.js em produção)
    const start = Math.max(0, i - WINDOW + 1);
    const window = candles.slice(start, i + 1);

    const context = {};
    if (cfg.needsRank || cfg.needsQqq) {
      const ds = dateStr(bar.time);
      if (cfg.needsRank) context.rank = dailyCtx.rankByDate[ds]?.[ticker] ?? null;
      if (cfg.needsQqq) context.qqqPositive = dailyCtx.qqqPositiveByDate[ds] ?? null;
    }

    const { signal } = cfg.mod.generateSignal(window, pos?.side ?? null, context);

    if (signal === 'long' || signal === 'short') {
      if (!pos) pos = { side: signal, entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, extremePrice: price, trailActive: false, tpTaken: false };
    } else if (signal === 'close_long' || signal === 'close_short') {
      if (pos) { closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'sinal'); pos = null; }
    } else if (signal === 'flip_to_long' || signal === 'flip_to_short') {
      if (pos) {
        closeTrade(trades, ticker, pos.side, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'flip');
        const newSide = signal === 'flip_to_long' ? 'long' : 'short';
        pos = { side: newSide, entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, extremePrice: price, trailActive: false, tpTaken: false };
      }
    }
  }

  return { trades, stillOpen: !!pos };
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
  console.log(`Universo: ${universe.length} stocks/ETFs (de ${RAW_SYMBOLS.length} na lista)\n`);

  const neededTimeframes = [...new Set(STRATS.map(s => s.timeframe))];
  console.log(`Timeframes necessários: ${neededTimeframes.join(', ')}`);

  const dataByTf = {};
  for (const tf of neededTimeframes) {
    console.log(`\nA obter velas ${tf} (${candlesNeeded(tf)} por símbolo)...`);
    dataByTf[tf] = await fetchUniverse(exchange, universe, tf);
  }

  console.log('\nA calcular ranking EMA90 diário e regime QQQ (para EMA90TopFade)...');
  const dailyCtx = computeDailyContext(dataByTf['1d'] || {});

  // results[stratKey][ticker] = stats
  const results = {};
  const rawTrades = {};

  for (const cfg of STRATS) {
    console.log(`\n=== ${cfg.key} (${cfg.timeframe}) ===`);
    results[cfg.key] = {};
    rawTrades[cfg.key] = {};
    const tfData = dataByTf[cfg.timeframe] || {};
    let doneCount = 0;
    for (const [ticker, candles] of Object.entries(tfData)) {
      try {
        const { trades, stillOpen } = simulateStrategy(cfg, ticker, candles, dailyCtx);
        results[cfg.key][ticker] = { ...stats(trades), stillOpen };
        rawTrades[cfg.key][ticker] = trades;
      } catch (err) {
        results[cfg.key][ticker] = { error: err.message };
      }
      doneCount++;
      if (doneCount % 10 === 0) process.stdout.write('.');
    }
    console.log(` ${doneCount} símbolos simulados`);
  }

  // ---- Relatório ----
  console.log('\n\n════════════════════════════════════════════════════════');
  console.log('RESUMO GLOBAL POR ESTRATÉGIA (agregado sobre todos os stocks)');
  console.log('════════════════════════════════════════════════════════');
  const stratSummary = STRATS.map(cfg => {
    const all = Object.values(results[cfg.key]).filter(r => !r.error);
    const totalTrades = all.reduce((a, r) => a + r.trades, 0);
    const totalPnl = all.reduce((a, r) => a + r.totalPnl, 0);
    const totalWins = all.reduce((a, r) => a + r.wins, 0);
    const symbolsWithTrades = all.filter(r => r.trades > 0).length;
    const symbolsProfitable = all.filter(r => r.totalPnl > 0).length;
    return {
      key: cfg.key, timeframe: cfg.timeframe, totalTrades, totalPnl,
      winRate: totalTrades ? (totalWins / totalTrades) * 100 : 0,
      symbolsWithTrades, symbolsProfitable,
      pnlPerTrade: totalTrades ? totalPnl / totalTrades : 0,
    };
  }).sort((a, b) => b.totalPnl - a.totalPnl);

  console.table(stratSummary.map(s => ({
    estrategia: s.key, tf: s.timeframe, trades: s.totalTrades,
    winRate: s.winRate.toFixed(1) + '%',
    pnlTotal: s.totalPnl.toFixed(2),
    pnlPorTrade: s.pnlPerTrade.toFixed(3),
    stocksComTrades: s.symbolsWithTrades,
    stocksLucrativos: s.symbolsProfitable,
  })));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`MELHOR ESTRATÉGIA POR STOCK (mínimo ${MIN_TRADES} trades fechados)`);
  console.log('════════════════════════════════════════════════════════');

  const allTickers = [...new Set(universe.map(u => u.ticker))].sort();
  const perStockBest = [];
  for (const ticker of allTickers) {
    const candidates = STRATS
      .map(cfg => ({ key: cfg.key, r: results[cfg.key][ticker] }))
      .filter(c => c.r && !c.r.error && c.r.trades >= MIN_TRADES);
    if (!candidates.length) {
      perStockBest.push({ stock: ticker, melhor: '—', trades: 0, pnl: 0, winRate: 0, pf: 0, nota: 'sem estratégia com sinais suficientes' });
      continue;
    }
    candidates.sort((a, b) => b.r.totalPnl - a.r.totalPnl);
    const best = candidates[0];
    perStockBest.push({
      stock: ticker, melhor: best.key, trades: best.r.trades,
      pnl: best.r.totalPnl, winRate: best.r.winRate,
      pf: best.r.pf === Infinity ? 999 : best.r.pf,
    });
  }
  perStockBest.sort((a, b) => b.pnl - a.pnl);
  console.table(perStockBest.map(s => ({
    stock: s.stock, melhorEstrategia: s.melhor, trades: s.trades,
    pnl: s.pnl.toFixed(2), winRate: s.winRate ? s.winRate.toFixed(1) + '%' : '-',
    pf: s.pf ? (s.pf === 999 ? '∞' : s.pf.toFixed(2)) : '-',
    nota: s.nota || '',
  })));

  console.log('\n════════════════════════════════════════════════════════');
  console.log('QUANTOS STOCKS CADA ESTRATÉGIA "GANHA" (melhor PnL entre as válidas)');
  console.log('════════════════════════════════════════════════════════');
  const winsByStrat = {};
  perStockBest.forEach(s => { if (s.melhor !== '—') winsByStrat[s.melhor] = (winsByStrat[s.melhor] || 0) + 1; });
  console.table(Object.entries(winsByStrat).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ estrategia: k, stocksGanhos: v })));

  // Guarda resultado completo em JSON para consulta posterior
  const outPath = path.join(__dirname, 'data', 'study-all-strategies-x-stocks-result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results, perStockBest, stratSummary }, null, 2));
  console.log(`\nResultado completo guardado em: ${outPath}`);
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
