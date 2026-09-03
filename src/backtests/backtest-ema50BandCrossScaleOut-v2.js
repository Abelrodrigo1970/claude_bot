// Variante de estudo da Ema50BandCrossScaleOut (ver
// src/strategies/ema50BandCrossScaleOut.js e backtest-ema50BandCrossScaleOut.js):
// mesma entrada (banda <3% acima da EMA50 OU cruzamento para cima da EMA50),
// mesmo SL 10%, mesmos TP1 28%/30% e TP2 48%/30% — só muda a saída "de
// tendência": em vez de fechar quando o preço cai abaixo da EMA90, fecha
// quando o preço cai 2% abaixo da EMA50. Mantém a saída por RSI(14)>87.
// Reutiliza strat.calculateIndicators (entrada) mas calcula a sua própria
// condição de saída — não mexe no módulo da estratégia registada.
//
// Corre com: node src/backtests/backtest-ema50BandCrossScaleOut-v2.js [dias]
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
const EMA50_EXIT_BAND_PCT = 2; // saída quando o preço está >=2% abaixo da EMA50
const RSI_EXIT_MAX = 87;

// Mesmo snapshot do scanner EMA90 usado no estudo original (03/09/2026).
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

    const minCandles = strat.EMA_SLOW_PERIOD + strat.RSI_PERIOD + 10;
    if (candles.length >= minCandles) {
      const start = Math.max(0, i - WINDOW + 1);
      const window = candles.slice(start, i + 1);
      const ind = strat.calculateIndicators(window);

      // Filtro pedido pelo utilizador (03/09): não entra se a própria vela
      // de entrada já teve um movimento >20% (open->close) — evita comprar
      // no meio de um pump vertical/candle de exaustão, fora do perfil
      // "banda estreita perto da EMA50" que a estratégia procura.
      const entryCandleMovePct = bar.open > 0 ? Math.abs((bar.close - bar.open) / bar.open) * 100 : 0;
      const entryCandleOk = entryCandleMovePct <= 20;

      if (!pos && ind.validEntry && entryCandleOk) {
        pos = { entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, tpTierIndex: 0 };
      } else if (pos) {
        const belowEma50Band = ind.ema50 != null && price < ind.ema50 * (1 - EMA50_EXIT_BAND_PCT / 100);
        const rsiOverbought  = ind.rsi != null && ind.rsi > RSI_EXIT_MAX;
        if (belowEma50Band || rsiOverbought) {
          const tag = belowEma50Band ? 'ema50-2pct-exit' : 'rsi87-exit';
          closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, tag);
          pos = null;
        }
      }
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

  console.log(`Universo: ${SYMBOLS.length} símbolos (snapshot scanner EMA90, 03/09/2026)`);
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
  console.log(`Ema50BandCrossScaleOut V2 — ${DAYS} dias, universo EMA90, 4h, SL 10%, TP1 28%/30%, TP2 48%/30%, saída <2% da EMA50 ou RSI>87, filtro vela entrada <=20%`);
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
