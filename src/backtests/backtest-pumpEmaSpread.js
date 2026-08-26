// Backtest da PumpEmaSpread (ver src/strategies/pumpEmaSpread.js) sobre o
// universo do scanner Pump 24h (todos os pares cripto com variação 24h
// >= 10%, sem limite de topN — ver scanner.js/startScanPump), timeframe 5m.
// Long/short conforme EMA12 vs EMA21, só entra com o spread na banda
// 0.6%-1.5%, fecha quando a direção inverte. Sem SL/TP — saída é só sinal.
// Chama generateSignal diretamente a cada vela (sem lookahead).
//
// Corre com: node src/backtests/backtest-pumpEmaSpread.js [dias]
const ccxt = require('ccxt');
const strat = require('../strategies/pumpEmaSpread');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const DAYS = parseInt(process.argv[2], 10) || 30;
const THRESHOLD_PCT = 10; // universo: pump 24h >= 10%
// Janela de candles passada ao generateSignal a cada vela — não a história
// toda (fica O(n²) e muito lento com milhares de velas de 5m). EMA21
// converge em poucas dezenas de velas, 200 dá folga de sobra e mantém o
// mesmo generateSignal() da estratégia real, sem duplicar a lógica aqui.
const WARMUP_CANDLES = 200;
const CANDLES_NEEDED = DAYS * 24 * 12 + WARMUP_CANDLES; // 12 velas de 5m por hora
const NOTIONAL = 60;
const TAKER_FEE = 0.00055;

function makeTrade(trades, symbol, side, entryPrice, entryTime, exitPrice, exitTime, qty, reason) {
  const grossPnl = side === 'long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ symbol, side, entryPrice, entryTime, exitPrice, exitTime, pnl: grossPnl - fee, pnlPct, reason });
}

function backtestSymbol(symbol, candles) {
  if (candles.length < WARMUP_CANDLES + 1) return [];

  const trades = [];
  let position = null; // { side, entryPrice, entryTime, qty }

  for (let i = WARMUP_CANDLES; i < candles.length; i++) {
    const bar = candles[i];
    const window = candles.slice(i - WARMUP_CANDLES, i + 1);
    const { signal } = strat.generateSignal(window, position ? position.side : null);
    const price = bar.close;

    if (!position) {
      if (signal === 'long' || signal === 'short') {
        position = { side: signal, entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price };
      }
      continue;
    }

    if ((position.side === 'long' && signal === 'close_long') || (position.side === 'short' && signal === 'close_short')) {
      makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, price, bar.time, position.qty, 'signal');
      position = null;
    }
  }

  return trades;
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  console.log(`A obter universo Pump 24h (variação >= +${THRESHOLD_PCT}%)...`);
  const markets = Object.values(exchange.markets).filter(m =>
    m.linear && m.type === 'swap' && m.settle === 'USDT' && m.active && !m.symbol.includes('USDC')
  );
  const tickers = await exchange.fetchTickers(markets.map(m => m.symbol));
  const universe = markets
    .map(m => ({ symbol: m.symbol, change24h: tickers[m.symbol]?.percentage ?? null }))
    .filter(r => r.change24h != null && r.change24h >= THRESHOLD_PCT)
    .sort((a, b) => b.change24h - a.change24h);

  console.log(`Universo: ${universe.length} pares acima de +${THRESHOLD_PCT}% agora`);
  console.log(universe.map(r => `${r.symbol.split('/')[0]} (+${r.change24h.toFixed(1)}%)`).join(', '));
  console.log(`\nA obter ${CANDLES_NEEDED} velas de 5m por símbolo (${DAYS} dias)...\n`);

  const allTrades = [];
  let ok = 0, skipped = [];

  for (const { symbol } of universe) {
    try {
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, '5m', CANDLES_NEEDED);
      const candles = ohlcv.map(([time, open, high, low, close, volume]) => ({ time: new Date(time), open, high, low, close, volume }));
      const trades = backtestSymbol(symbol.split('/')[0], candles);
      allTrades.push(...trades);
      ok++;
      process.stdout.write('.');
    } catch (err) {
      skipped.push(`${symbol.split('/')[0]} (${err.message})`);
      process.stdout.write('x');
    }
  }
  console.log(`\n\n${ok} símbolos processados, ${skipped.length} ignorados.\n`);

  const closed = allTrades.filter(t => t.exitTime);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  let equity = 0, peak = 0, maxDD = 0;
  for (const t of closed.slice().sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.pnl; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity - peak);
  }

  console.log('════════════════════════════════════════════════');
  console.log(`ESTUDO — PumpEmaSpread, universo Pump24h (${DAYS} dias, 5m, banda spread 0.6-1.5%)`);
  console.log('════════════════════════════════════════════════');
  console.log(`Trades fechados: ${closed.length}`);
  console.log(`Win rate: ${winRate.toFixed(1)}%`);
  console.log(`PnL total: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`);
  console.log(`PnL médio/trade: ${(totalPnl / (closed.length || 1)).toFixed(3)} USDT`);
  console.log(`Profit factor: ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
  console.log(`Max drawdown: ${maxDD.toFixed(2)} USDT`);

  const longs = closed.filter(t => t.side === 'long');
  const shorts = closed.filter(t => t.side === 'short');
  console.log(`\nLong: ${longs.length} trades, PnL ${longs.reduce((a, t) => a + t.pnl, 0).toFixed(2)} USDT, WR ${(longs.filter(t => t.pnl > 0).length / (longs.length || 1) * 100).toFixed(1)}%`);
  console.log(`Short: ${shorts.length} trades, PnL ${shorts.reduce((a, t) => a + t.pnl, 0).toFixed(2)} USDT, WR ${(shorts.filter(t => t.pnl > 0).length / (shorts.length || 1) * 100).toFixed(1)}%`);

  const bySymbol = {};
  closed.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, n: 0, wins: 0 };
    bySymbol[t.symbol].pnl += t.pnl;
    bySymbol[t.symbol].n++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
  });
  const top = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  console.log('\n===== POR SÍMBOLO =====');
  console.table(top.map(([s, r]) => ({
    symbol: s, trades: r.n, winRate: ((r.wins / r.n) * 100).toFixed(1) + '%', pnl: r.pnl.toFixed(2),
  })));

  if (skipped.length) console.log(`\nIgnorados: ${skipped.join(', ')}`);
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
