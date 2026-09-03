// Backtest da VolumeSpike3xScaleOut (src/strategies/volumeSpike3xScaleOut.js)
// sobre o universo fixo do scanner "Lista 50" (top50-6month-movers.json),
// com a MESMA gestão de posição configurada em produção (runner.js):
// SL fixo 4%, TP1 +8%/30%, TP2 +45%/30% (cada fraction fecha % do que
// resta nesse momento, não da entrada original), e o resto sai quando o
// preço fecha abaixo da EMA50 de 15m (sinal da própria estratégia).
//
// Corre com: node src/backtests/backtest-volumeSpike3xScaleOut.js [dias]
require('dotenv').config();
const ccxt = require('ccxt');
const strat = require('../strategies/volumeSpike3xScaleOut');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL  = 60;
const TAKER_FEE = 0.00055;
const WINDOW    = 250;
const TIMEFRAME = '15m';
const DAYS      = parseInt(process.argv[2], 10) || 30;
const SL_PCT    = 0.04;
const TP_TIERS  = [
  { pct: 0.08, fraction: 0.30 },
  { pct: 0.45, fraction: 0.30 },
];

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map(m => m.symbol);

function candlesNeeded() {
  const barsPerDay = (24 * 60) / 15;
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
  const grossPnl = (exitPrice - entryPrice) * qty; // long-only
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  trades.push({ ticker, entryPrice, entryTime, exitPrice, exitTime, qty, pnl: grossPnl - fee, pnlPct, tag });
}

// Réplica fiel da gestão de posição do runner.js: TP em vários níveis
// (cada fraction fecha % do que resta), depois SL fixo, depois sinal da
// estratégia (entrada / saída por EMA50).
function simulate(ticker, candles) {
  const trades = [];
  let pos = null; // { entryPrice, entryTime, qty, tpTierIndex }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;

    if (pos) {
      const tier = TP_TIERS[pos.tpTierIndex];
      if (tier) {
        const gainPct = (price - pos.entryPrice) / pos.entryPrice;
        if (gainPct >= tier.pct) {
          const closeQty = pos.qty * tier.fraction;
          closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, closeQty, `tp${pos.tpTierIndex + 1}`);
          pos.qty -= closeQty;
          pos.tpTierIndex++;
          if (pos.qty <= 1e-9) pos = null;
        }
      }
    }

    if (pos) {
      const lossPct = (pos.entryPrice - price) / pos.entryPrice;
      if (lossPct >= SL_PCT) {
        closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'stop-loss');
        pos = null;
        continue;
      }
    }

    const start = Math.max(0, i - WINDOW + 1);
    const window = candles.slice(start, i + 1);
    const { signal } = strat.generateSignal(window, pos ? 'long' : null);

    if (signal === 'long' && !pos) {
      pos = { entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, tpTierIndex: 0 };
    } else if (signal === 'close_long' && pos) {
      closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'ema50-exit');
      pos = null;
    }
  }

  let openMtmPnl = 0;
  if (pos) {
    const lastPrice = candles[candles.length - 1].close;
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
  const byTag = {};
  trades.forEach(t => { byTag[t.tag] = (byTag[t.tag] || 0) + 1; });
  return { trades: trades.length, wins: wins.length, winRate, totalPnl, pf, maxDD, byTag };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  console.log(`Universo: ${SYMBOLS.length} símbolos (Lista 50)`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo, ${DAYS} dias)...`);
  const data = await fetchUniverse(exchange);

  const perTicker = {};
  let allTrades = [];
  let openMtm = 0, openCount = 0;

  for (const [ticker, candles] of Object.entries(data)) {
    const { trades, stillOpen, openMtmPnl } = simulate(ticker, candles);
    perTicker[ticker] = stats(trades);
    allTrades = allTrades.concat(trades);
    openMtm += openMtmPnl;
    if (stillOpen) openCount++;
  }

  const overall = stats(allTrades);
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`VolumeSpike3xScaleOut — ${DAYS} dias, Lista 50, SL 4%, TP1 8%/30%, TP2 45%/30%, saída <EMA50`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`Trades fechados: ${overall.trades} · Ainda abertas: ${openCount} · Win rate: ${overall.winRate.toFixed(1)}%`);
  console.log(`PnL fechados: ${overall.totalPnl >= 0 ? '+' : ''}${overall.totalPnl.toFixed(2)} USDT · MtM abertas: ${openMtm >= 0 ? '+' : ''}${openMtm.toFixed(2)} · PnL total: ${(overall.totalPnl + openMtm) >= 0 ? '+' : ''}${(overall.totalPnl + openMtm).toFixed(2)} USDT`);
  console.log(`Profit factor: ${overall.pf === Infinity ? '∞' : overall.pf.toFixed(2)} · Max drawdown: ${overall.maxDD.toFixed(2)}`);
  console.log(`Motivos de saída: ${JSON.stringify(overall.byTag)}`);

  const rows = Object.entries(perTicker)
    .map(([ticker, s]) => ({ stock: ticker, trades: s.trades, winRate: s.winRate.toFixed(1) + '%', pnl: s.totalPnl.toFixed(2), pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2) }))
    .sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  console.log('\n════════════════════════════════════════════════════════');
  console.log('POR SÍMBOLO (ordenado por PnL)');
  console.log('════════════════════════════════════════════════════════');
  console.table(rows);
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
