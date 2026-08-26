// Backtest fiel ao funcionamento real da PumpEma60Band: só EMA60. LONG na
// banda 0-3% acima, vira SHORT quando fecha <-2% abaixo, volta a virar LONG
// na banda 0-3%. SL fixo de 10% (não trailing) — verificado por high/low
// intracandle, tal como os TPs/SLs dos outros backtests da pasta.
//
// Mesma metodologia de janela real da PumpEmaSpread/PumpTrendFlip — cada
// símbolo só entra em simulação a partir do momento em que apareceu pela 1ª
// vez no scanner Pump 24h (tabela scanner_pump). No fim, qualquer posição
// ainda aberta é fechada ao preço atual (mark-to-market).
//
// Corre com: node src/backtests/backtest-pumpEma60Band-live.js [timeframe] [tpPct] [tpFraction] [exitMode]
// (timeframe: 5m, 15m, 1h, 4h... default 1h · tpPct: ex 15 para TP parcial a
// +15%, 0/omitido desliga · tpFraction: fração fechada no TP, default 0.5 ·
// exitMode: "flip" (default, long+short com flip) · "long" (long-only, o
// gatilho <-2% fecha e fica flat em vez de virar short) · "longsl" (long-only
// E o gatilho <-2% fica completamente desligado — só sai por SL 10% ou
// mark-to-market no fim; ainda entra de novo se voltar à banda 0-3% depois
// de um SL)
const ccxt = require('ccxt');
const strat = require('../strategies/pumpEma60Band');
const pool = require('../db/pool');

const TIMEFRAME = process.argv[2] || '1h';
const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240 }[TIMEFRAME];
if (!TF_MINUTES) { console.error(`Timeframe desconhecido: ${TIMEFRAME}`); process.exit(1); }

const TP_PCT = parseFloat(process.argv[3] || '0') / 100; // 0 = desligado
const TP_FRACTION = parseFloat(process.argv[4] || '0.5');
const EXIT_MODE = process.argv[5] || 'flip'; // 'flip' | 'long' | 'longsl'
const LONG_ONLY = EXIT_MODE === 'long' || EXIT_MODE === 'longsl';
const DISABLE_SIGNAL_EXIT = EXIT_MODE === 'longsl';

const WARMUP_CANDLES = 200; // para a EMA60 convergir — não gera sinais aqui
const NOTIONAL = 60;
const TAKER_FEE = 0.00055;
const SL_PCT = 0.10;

function makeTrade(trades, symbol, side, entryPrice, entryTime, exitPrice, exitTime, qty, reason) {
  const grossPnl = side === 'long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ symbol, side, entryPrice, entryTime, exitPrice, exitTime, pnl: grossPnl - fee, pnlPct, reason });
}

function openPos(side, price, time) {
  return { side, entryPrice: price, entryTime: time, qty: NOTIONAL / price, tpTaken: false };
}

function backtestSymbol(symbol, candles, firstSeen) {
  const trades = [];
  let position = null;

  for (let i = WARMUP_CANDLES; i < candles.length; i++) {
    const bar = candles[i];
    if (bar.time < firstSeen) continue;

    if (position && TP_PCT > 0 && !position.tpTaken) {
      const tpPrice = position.side === 'long'
        ? position.entryPrice * (1 + TP_PCT)
        : position.entryPrice * (1 - TP_PCT);
      const tpHit = position.side === 'long' ? bar.high >= tpPrice : bar.low <= tpPrice;
      if (tpHit) {
        const closeQty = position.qty * TP_FRACTION;
        makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, tpPrice, bar.time, closeQty, 'take-profit-parcial');
        position.qty -= closeQty;
        position.tpTaken = true;
      }
    }

    if (position) {
      const slPrice = position.side === 'long'
        ? position.entryPrice * (1 - SL_PCT)
        : position.entryPrice * (1 + SL_PCT);
      const slHit = position.side === 'long' ? bar.low <= slPrice : bar.high >= slPrice;
      if (slHit) {
        makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, slPrice, bar.time, position.qty, 'stop-loss');
        position = null;
        continue;
      }
    }

    const window = candles.slice(Math.max(0, i - WARMUP_CANDLES), i + 1);
    const { signal } = strat.generateSignal(window, position ? position.side : null);
    const price = bar.close;

    if (!position) {
      if (signal === 'long' || (signal === 'short' && !LONG_ONLY)) position = openPos(signal, price, bar.time);
      continue;
    }

    if (DISABLE_SIGNAL_EXIT) continue; // só SL ou mark-to-market fecham — ignora o gatilho <-2%

    if (signal === 'flip_to_short' && position.side === 'long') {
      if (LONG_ONLY) {
        makeTrade(trades, symbol, 'long', position.entryPrice, position.entryTime, price, bar.time, position.qty, 'close');
        position = null; // fica flat — sem flips, só volta a entrar quando a banda 0-3% reaparecer
      } else {
        makeTrade(trades, symbol, 'long', position.entryPrice, position.entryTime, price, bar.time, position.qty, 'flip');
        position = openPos('short', price, bar.time);
      }
    } else if (signal === 'flip_to_long' && position.side === 'short') {
      makeTrade(trades, symbol, 'short', position.entryPrice, position.entryTime, price, bar.time, position.qty, 'flip');
      position = openPos('long', price, bar.time);
    }
  }

  if (position) {
    const last = candles[candles.length - 1];
    makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, last.close, last.time, position.qty, 'mark-to-market');
  }

  return trades;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT symbol, MIN(scanned_at) AS first_seen
    FROM scanner_pump GROUP BY symbol ORDER BY first_seen
  `);
  console.log(`Símbolos com histórico real no scanner Pump 24h: ${rows.length}`);
  console.log(`Primeira sessão: ${rows.reduce((min, r) => r.first_seen < min ? r.first_seen : min, rows[0].first_seen).toISOString()}`);
  console.log(`Timeframe: ${TIMEFRAME} · EMA60, banda long 0-3%, gatilho short <-2% · SL fixo ${(SL_PCT * 100).toFixed(0)}%` +
    (TP_PCT > 0 ? ` · TP parcial ${(TP_FRACTION * 100).toFixed(0)}%@${(TP_PCT * 100).toFixed(0)}%` : ' · sem TP parcial') +
    (DISABLE_SIGNAL_EXIT ? ' · LONG-ONLY, gatilho <-2% DESLIGADO (só SL/mark-to-market)'
      : LONG_ONLY ? ' · LONG-ONLY (flips desligados)' : ' · long+short com flip') + '\n');

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  const allTrades = [];
  let ok = 0, skipped = [];

  for (const r of rows) {
    const symbol = r.symbol;
    const firstSeen = new Date(r.first_seen);
    const minutesSinceFirstSeen = (Date.now() - firstSeen.getTime()) / 60000;
    const candlesNeeded = Math.min(WARMUP_CANDLES + Math.ceil(minutesSinceFirstSeen / TF_MINUTES) + 5, 1000);

    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, candlesNeeded);
      const candles = ohlcv.map(([time, open, high, low, close, volume]) => ({ time: new Date(time), high, low, close }));
      const trades = backtestSymbol(symbol.split('/')[0], candles, firstSeen);
      allTrades.push(...trades);
      ok++;
      process.stdout.write('.');
    } catch (err) {
      skipped.push(`${symbol.split('/')[0]} (${err.message})`);
      process.stdout.write('x');
    }
  }
  console.log(`\n\n${ok} símbolos processados, ${skipped.length} ignorados.\n`);

  const closed = allTrades;
  console.log(`===== TODOS OS TRADES (flip, stop-loss, ou mark-to-market) =====`);
  console.log(`Total: ${closed.length}`);
  if (closed.length) {
    console.table(closed.map(t => ({
      symbol: t.symbol, side: t.side, motivo: t.reason,
      entrada: t.entryTime.toISOString().slice(0, 16).replace('T', ' '),
      saida: t.exitTime.toISOString().slice(0, 16).replace('T', ' '),
      horas: ((t.exitTime - t.entryTime) / 3600000).toFixed(1),
      pnlPct: t.pnlPct.toFixed(2) + '%',
      pnl: t.pnl.toFixed(2),
    })));

    const wins = closed.filter(t => t.pnl > 0);
    const totalPnl = closed.reduce((a, t) => a + t.pnl, 0);
    console.log(`\nWin rate: ${((wins.length / closed.length) * 100).toFixed(1)}% · PnL total: ${totalPnl.toFixed(2)} USDT`);

    console.log('\n===== POR MOTIVO DE SAÍDA =====');
    const byReason = {};
    closed.forEach(t => {
      if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0, wins: 0 };
      byReason[t.reason].n++;
      byReason[t.reason].pnl += t.pnl;
      if (t.pnl > 0) byReason[t.reason].wins++;
    });
    console.table(Object.entries(byReason).map(([reason, r]) => ({
      motivo: reason, trades: r.n, winRate: ((r.wins / r.n) * 100).toFixed(1) + '%', pnl: r.pnl.toFixed(2),
    })));

    console.log('\n===== POR SÍMBOLO =====');
    const bySymbol = {};
    closed.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { n: 0, pnl: 0, wins: 0 };
      bySymbol[t.symbol].n++;
      bySymbol[t.symbol].pnl += t.pnl;
      if (t.pnl > 0) bySymbol[t.symbol].wins++;
    });
    console.table(Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([symbol, r]) => ({
      symbol, trades: r.n, winRate: ((r.wins / r.n) * 100).toFixed(1) + '%', pnl: r.pnl.toFixed(2),
    })));
  }

  if (skipped.length) console.log(`\nIgnorados: ${skipped.join(', ')}`);
  await pool.end();
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
