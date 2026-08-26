// Estudo de FADE (apostar contra o pump, à espera da reversão) sobre os 50
// símbolos de src/backtests/data/top50-6month-movers.json — todos já
// devolveram >40% do pico nos últimos 6 meses, ou seja, já sabemos que
// "reverter" é o padrão dominante nesta lista.
//
// Regra: SHORT quando o fecho diário está mais de THRESHOLD% acima da
// EMA20 (mede o quão esticado está vs. a própria tendência recente, não vs.
// um preço absoluto). Fecha quando o preço volta a fechar abaixo da EMA20
// (reversão à média completa) — sem SL próprio nesta primeira versão, para
// ver o potencial "puro" do fade antes de acrescentar proteção.
//
// Corre com: node src/backtests/study-fade-6month-movers.js [thresholdPct] [days] [slPct]
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');

const THRESHOLD_PCT = parseFloat(process.argv[2] || '50') / 100;
const DAYS = parseInt(process.argv[3] || '220', 10); // cobre os 182 dias do estudo + aquecimento da EMA20
const SL_PCT = parseFloat(process.argv[4] || '0') / 100; // 0 = desligado (sem SL — perigoso, ver leitura do estudo)
const NOTIONAL = 60;
const TAKER_FEE = 0.00055;

function makeTrade(trades, symbol, entryPrice, entryTime, exitPrice, exitTime, qty, reason) {
  const grossPnl = (entryPrice - exitPrice) * qty; // short: ganha quando o preço cai
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ symbol, entryPrice, entryTime, exitPrice, exitTime, pnl: grossPnl - fee, pnlPct, reason,
    days: (exitTime - entryTime) / 86400000 });
}

function backtestSymbol(symbol, candles) {
  const closes = candles.map(c => c.close);
  const ema20Arr = EMA.calculate({ period: 20, values: closes });
  const offset = closes.length - ema20Arr.length;

  const trades = [];
  let position = null; // { entryPrice, entryTime, qty }

  for (let i = 0; i < ema20Arr.length; i++) {
    const ci = i + offset;
    const ema20 = ema20Arr[i];
    const price = closes[ci];
    const bar = candles[ci];
    const time = bar.time;
    const distPct = (price - ema20) / ema20;

    if (!position) {
      if (distPct > THRESHOLD_PCT) {
        position = { entryPrice: price, entryTime: time, qty: NOTIONAL / price };
      }
      continue;
    }

    if (SL_PCT > 0) {
      const slPrice = position.entryPrice * (1 + SL_PCT);
      if (bar.high >= slPrice) {
        makeTrade(trades, symbol, position.entryPrice, position.entryTime, slPrice, time, position.qty, 'stop-loss');
        position = null;
        continue;
      }
    }

    if (price < ema20) {
      makeTrade(trades, symbol, position.entryPrice, position.entryTime, price, time, position.qty, 'reversao-media');
      position = null;
    }
  }

  if (position) {
    const last = candles[candles.length - 1];
    makeTrade(trades, symbol, position.entryPrice, position.entryTime, last.close, last.time, position.qty, 'mark-to-market');
  }

  return trades;
}

async function main() {
  const movers = require('./data/top50-6month-movers.json').movers;
  console.log(`Estudo de fade: ${movers.length} símbolos · limiar EMA20+${(THRESHOLD_PCT * 100).toFixed(0)}% · ${DAYS} dias de candles diárias · SL: ${SL_PCT > 0 ? (SL_PCT * 100).toFixed(0) + '%' : 'desligado'}\n`);

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  const allTrades = [];
  let ok = 0, skipped = [];

  for (const m of movers) {
    try {
      const ohlcv = await exchange.fetchOHLCV(m.symbol, '1d', undefined, DAYS);
      const candles = ohlcv.map(([t, o, h, l, c]) => ({ time: new Date(t), high: h, low: l, close: c }));
      if (candles.length < 25) { skipped.push(m.symbol.split('/')[0] + ' (poucas velas)'); continue; }
      const trades = backtestSymbol(m.symbol.split('/')[0], candles);
      allTrades.push(...trades);
      ok++;
      process.stdout.write('.');
    } catch (err) {
      skipped.push(`${m.symbol.split('/')[0]} (${err.message})`);
      process.stdout.write('x');
    }
  }
  console.log(`\n\n${ok}/${movers.length} símbolos processados, ${skipped.length} ignorados.\n`);

  console.log(`===== TODOS OS TRADES DE FADE (short em EMA20+${(THRESHOLD_PCT * 100).toFixed(0)}%) =====`);
  console.log(`Total: ${allTrades.length}`);
  if (allTrades.length) {
    console.table(allTrades.map(t => ({
      symbol: t.symbol, motivo: t.reason,
      entrada: t.entryTime.toISOString().slice(0, 10),
      saida: t.exitTime.toISOString().slice(0, 10),
      dias: t.days.toFixed(1),
      pnlPct: t.pnlPct.toFixed(1) + '%',
      pnl: t.pnl.toFixed(2),
    })));

    const wins = allTrades.filter(t => t.pnl > 0);
    const totalPnl = allTrades.reduce((a, t) => a + t.pnl, 0);
    console.log(`\nWin rate: ${((wins.length / allTrades.length) * 100).toFixed(1)}% · PnL total: ${totalPnl.toFixed(2)} USDT`);

    console.log('\n===== POR SÍMBOLO =====');
    const bySymbol = {};
    allTrades.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { n: 0, pnl: 0, wins: 0 };
      bySymbol[t.symbol].n++;
      bySymbol[t.symbol].pnl += t.pnl;
      if (t.pnl > 0) bySymbol[t.symbol].wins++;
    });
    console.table(Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([symbol, r]) => ({
      symbol, trades: r.n, winRate: ((r.wins / r.n) * 100).toFixed(1) + '%', pnl: r.pnl.toFixed(2),
    })));

    console.log('\n===== SÍMBOLOS SEM QUALQUER TRADE (nunca esticou >{threshold}% acima da EMA20) ====='.replace('{threshold}', (THRESHOLD_PCT * 100).toFixed(0)));
    const symbolsWithTrades = new Set(allTrades.map(t => t.symbol));
    const noTrade = movers.map(m => m.symbol.split('/')[0]).filter(s => !symbolsWithTrades.has(s));
    console.log(noTrade.join(', ') || '(nenhum)');
  }

  if (skipped.length) console.log(`\nIgnorados: ${skipped.join(', ')}`);
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
