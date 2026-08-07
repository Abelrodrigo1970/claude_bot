// Backtest da StochRSITop4Flip sobre a lista de stocks/ETFs existente
// (mesmos símbolos usados pelo StockSMA/Stoch50 — ver src/db/seed-stocks.js),
// últimos 30 dias, 1h. Para stocks não existe ranking "Top4 ganhos 24h" (esse
// filtro só faz sentido para o scanner de perpétuos cripto), por isso este
// teste usa só a parte de indicador da estratégia — cruzamento %K/%D +
// filtro da MA21 no fecho — para isolar o que dá para avaliar aqui: qual
// stock/ETF reage melhor a este StochRSI.
//
// Corre com: node src/backtests/backtest-stochRsiTop4-stocks.js
const ccxt = require('ccxt');
const strat = require('../strategies/stochRsiTop4Flip');

const DAYS = 30;
const CANDLES_NEEDED = 1000; // 1h — ~41 dias, cobre os 30 + aquecimento do indicador (156 velas)
const SL_LONG_PCT = 0.05;
const SL_SHORT_PCT = 0.07;

// Mesma lista de símbolos usada em src/db/seed-stocks.js (RAW_SYMBOLS),
// convertida para o formato Bybit "TICKER/USDT:USDT".
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

// Simula o motor do runner (ver runStrategyOnSymbol/openPosition em
// services/runner.js) mas sem o filtro de Top4 — long/flip_to_long dispara
// em qualquer crossUp; o resto (fecho no crossDown, short condicional à
// MA21, SL -5%/+7%, sem TP) é idêntico à estratégia real.
function backtestSymbol(candles) {
  const minCandles = 50 + 50 + 40 + 11 + 5; // igual ao minCandles da estratégia
  if (candles.length < minCandles + 1) return null;

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const trades = [];
  let position = null; // { side, entryPrice, entryTime }

  for (let i = minCandles; i < candles.length; i++) {
    const bar = candles[i];
    const closeTime = bar.time.getTime();

    // Stop-loss intrabar (usa high/low da própria vela, como uma ordem SL real teria disparado)
    if (position) {
      const slHit = position.side === 'long'
        ? bar.low <= position.entryPrice * (1 - SL_LONG_PCT)
        : bar.high >= position.entryPrice * (1 + SL_SHORT_PCT);
      if (slHit) {
        const exitPrice = position.side === 'long'
          ? position.entryPrice * (1 - SL_LONG_PCT)
          : position.entryPrice * (1 + SL_SHORT_PCT);
        trades.push(makeTrade(position, exitPrice, closeTime, 'stop-loss', closeTime >= cutoff));
        position = null;
        continue;
      }
    }

    const ind = strat.calculateIndicators(candles.slice(0, i + 1));
    const price = bar.close;

    if (!position && ind.crossUp) {
      position = { side: 'long', entryPrice: price, entryTime: closeTime };
      continue;
    }
    if (position?.side === 'short' && ind.crossUp) {
      trades.push(makeTrade(position, price, closeTime, 'flip', closeTime >= cutoff));
      position = { side: 'long', entryPrice: price, entryTime: closeTime };
      continue;
    }
    if (position?.side === 'long' && ind.crossDown) {
      trades.push(makeTrade(position, price, closeTime, 'signal', closeTime >= cutoff));
      position = ind.belowMa21 ? { side: 'short', entryPrice: price, entryTime: closeTime } : null;
    }
  }

  // Posição ainda aberta no fim da série — marca como "em aberto", fora das stats de win rate
  if (position) {
    const lastPrice = candles[candles.length - 1].close;
    trades.push(makeTrade(position, lastPrice, candles[candles.length - 1].time.getTime(), 'open-no-fim', true, true));
  }

  // Só entram nas estatísticas os trades cujo fecho caiu dentro da janela dos últimos 30 dias
  const windowTrades = trades.filter(t => t.inWindow && !t.stillOpen);
  const wins = windowTrades.filter(t => t.pnlPct > 0);
  const totalPnl = windowTrades.reduce((a, t) => a + t.pnlPct, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = windowTrades.filter(t => t.pnlPct <= 0).reduce((a, t) => a + Math.abs(t.pnlPct), 0);

  return {
    trades: windowTrades.length,
    wins: wins.length,
    winRate: windowTrades.length ? (wins.length / windowTrades.length) * 100 : null,
    totalPnlPct: totalPnl,
    avgPnlPct: windowTrades.length ? totalPnl / windowTrades.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    stillOpen: trades.some(t => t.stillOpen),
    allTrades: trades,
  };
}

function makeTrade(position, exitPrice, exitTime, reason, inWindow, stillOpen = false) {
  const pnlPct = position.side === 'long'
    ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
  return { side: position.side, entryPrice: position.entryPrice, entryTime: position.entryTime, exitPrice, exitTime, reason, pnlPct, inWindow, stillOpen };
}

async function main() {
  // Instância pública, sem credenciais — só dados de mercado (a chave da
  // conta em .env está inválida e nem é preciso para OHLCV).
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  const symbols = RAW_SYMBOLS.map(toSymbol);
  const results = [];
  const skipped = [];

  console.log(`A testar ${symbols.length} stocks/ETFs — StochRSI(50/50/40/11) 1h, ${DAYS} dias, sem filtro Top4...\n`);

  for (const { ticker, symbol } of symbols) {
    if (!exchange.markets[symbol]) { skipped.push(`${ticker} (sem mercado na Bybit)`); continue; }
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, CANDLES_NEEDED);
      const candles = ohlcv.map(([time, open, high, low, close, volume]) => ({ time: new Date(time), open, high, low, close, volume }));
      const r = backtestSymbol(candles);
      if (!r) { skipped.push(`${ticker} (candles insuficientes: ${candles.length})`); continue; }
      results.push({ ticker, ...r });
      process.stdout.write('.');
    } catch (err) {
      skipped.push(`${ticker} (erro: ${err.message})`);
      process.stdout.write('x');
    }
  }
  console.log('\n');

  const withTrades = results.filter(r => r.trades > 0).sort((a, b) => b.totalPnlPct - a.totalPnlPct);
  const noTrades = results.filter(r => r.trades === 0);

  console.log(`RESULTADOS — ${withTrades.length} stocks com trades fechados na janela de ${DAYS} dias (${noTrades.length} sem sinais, ${skipped.length} ignorados)\n`);
  console.log('Rank | Ticker       | Trades | WinRate | PnL total | PnL médio | PF    | Em aberto?');
  withTrades.forEach((r, i) => {
    const pf = r.profitFactor === Infinity ? '∞' : (r.profitFactor?.toFixed(2) ?? '—');
    console.log(
      `${String(i + 1).padStart(4)} | ${r.ticker.padEnd(12)} | ${String(r.trades).padStart(6)} | ` +
      `${r.winRate.toFixed(1).padStart(6)}% | ${(r.totalPnlPct >= 0 ? '+' : '')}${r.totalPnlPct.toFixed(2).padStart(7)}% | ` +
      `${(r.avgPnlPct >= 0 ? '+' : '')}${r.avgPnlPct.toFixed(2).padStart(6)}% | ${pf.padStart(5)} | ${r.stillOpen ? 'sim' : '—'}`
    );
  });

  if (skipped.length) {
    console.log(`\nIgnorados (${skipped.length}): ${skipped.join(', ')}`);
  }
  if (noTrades.length) {
    console.log(`\nSem trades na janela: ${noTrades.map(r => r.ticker).join(', ')}`);
  }
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
