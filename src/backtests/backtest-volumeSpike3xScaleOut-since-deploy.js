// Variante do backtest-volumeSpike3xScaleOut.js que corta os trades pela
// data exata do deploy do scanner Lista 50 novo (03/09 ~14:14 UTC / ~15:00
// em Lisboa) — pedido do utilizador para ver só a janela em que o scanner
// real esteve a correr. Aviso já: amostra pequena, poucas horas.
require('dotenv').config();
const ccxt = require('ccxt');
const strat = require('../strategies/volumeSpike3xScaleOut');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const NOTIONAL  = 60;
const TAKER_FEE = 0.00055;
const WINDOW    = 250;
const TIMEFRAME = '15m';
const FETCH_DAYS = 1; // buffer generoso — cortamos depois pelo cutoff exato
const SL_PCT    = 0.04;
const TP_TIERS  = [
  { pct: 0.08, fraction: 0.30 },
  { pct: 0.45, fraction: 0.30 },
];
const CUTOFF = new Date('2026-09-03T14:14:57Z'); // deploy do scanner novo

const SYMBOLS = require('./data/top50-6month-movers.json').movers.map(m => m.symbol);

function candlesNeeded() {
  const barsPerDay = (24 * 60) / 15;
  return Math.round(FETCH_DAYS * barsPerDay) + WINDOW + 10;
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
  let pos = null;

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

    // bar.time é a hora de ABERTURA da vela (convenção OHLCV) — a vela só
    // fica disponível (fechada) 15min depois. Comparar bar.time cru com o
    // cutoff excluía por engano a primeira vela pós-deploy (abriu antes do
    // deploy, fechou depois) — usa a hora de FECHO para a comparação.
    const barCloseTime = new Date(bar.time.getTime() + 15 * 60 * 1000);
    if (signal === 'long' && !pos && barCloseTime >= CUTOFF) {
      pos = { entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, tpTierIndex: 0 };
    } else if (signal === 'close_long' && pos) {
      closeTrade(trades, ticker, pos.entryPrice, pos.entryTime, price, bar.time, pos.qty, 'ema50-exit');
      pos = null;
    }
  }

  // Todos os trades aqui já só abriram quando a vela fechou depois do
  // cutoff (ver condição acima) — não precisa de filtro adicional.
  const filtered = trades;
  let openMtmPnl = 0, openInfo = null;
  if (pos) {
    const lastPrice = candles[candles.length - 1].close;
    openMtmPnl = (lastPrice - pos.entryPrice) * pos.qty;
    const pnlPct = ((lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
    openInfo = { ticker, entryPrice: pos.entryPrice, entryTime: pos.entryTime, lastPrice, pnlPct, tpTierIndex: pos.tpTierIndex };
  }
  return { trades: filtered, stillOpen: !!pos, openMtmPnl, openInfo };
}

function stats(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const byTag = {};
  trades.forEach(t => { byTag[t.tag] = (byTag[t.tag] || 0) + 1; });
  return { trades: trades.length, wins: wins.length, winRate, totalPnl, pf, byTag };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  await exchange.loadMarkets();

  console.log(`Universo: ${SYMBOLS.length} símbolos (Lista 50)`);
  console.log(`Cutoff (deploy do scanner novo): ${CUTOFF.toISOString()}`);
  console.log(`A obter velas ${TIMEFRAME} (${candlesNeeded()} por símbolo)...`);
  const data = await fetchUniverse(exchange);

  const perTicker = {};
  let allTrades = [];
  let openMtm = 0, openCount = 0;
  const openPositions = [];

  for (const [ticker, candles] of Object.entries(data)) {
    const { trades, stillOpen, openMtmPnl, openInfo } = simulate(ticker, candles);
    if (trades.length) perTicker[ticker] = stats(trades);
    allTrades = allTrades.concat(trades);
    openMtm += openMtmPnl;
    if (stillOpen) { openCount++; openPositions.push(openInfo); }
  }

  const overall = stats(allTrades);
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`VolumeSpike3xScaleOut — desde o deploy do scanner (${CUTOFF.toISOString()} → agora)`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`Trades fechados: ${overall.trades} · Ainda abertas: ${openCount} · Win rate (fechados): ${overall.winRate.toFixed(1)}%`);
  console.log(`PnL fechados: ${overall.totalPnl >= 0 ? '+' : ''}${overall.totalPnl.toFixed(2)} USDT · MtM abertas: ${openMtm >= 0 ? '+' : ''}${openMtm.toFixed(2)} USDT · Total: ${(overall.totalPnl + openMtm) >= 0 ? '+' : ''}${(overall.totalPnl + openMtm).toFixed(2)} USDT`);
  console.log(`Profit factor: ${overall.pf === Infinity ? '∞' : overall.pf.toFixed(2)}`);
  console.log(`Motivos de saída: ${JSON.stringify(overall.byTag)}`);

  if (openPositions.length) {
    console.log('\n--- Posições ainda abertas ---');
    console.table(openPositions.map(p => ({
      stock: p.ticker, entrada: p.entryPrice, agora: p.lastPrice,
      pnlFlutuante: p.pnlPct.toFixed(2) + '%', tpAtingidos: p.tpTierIndex, desde: p.entryTime.toISOString(),
    })));
  }

  if (overall.trades) {
    const rows = Object.entries(perTicker)
      .map(([ticker, s]) => ({ stock: ticker, trades: s.trades, winRate: s.winRate.toFixed(1) + '%', pnl: s.totalPnl.toFixed(2) }))
      .sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
    console.log('\n--- Trades fechados ---');
    console.table(rows);
  } else {
    console.log('\nSem trades fechados nesta janela.');
  }
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
