// Backtest fiel ao funcionamento real: a estratégia só pode agir sobre um
// símbolo a partir do momento em que ele apareceu pela PRIMEIRA VEZ no
// scanner Pump 24h (tabela scanner_pump) — não sobre o histórico inteiro do
// par. O scanner só arrancou em 25/08 ~21:36 UTC, por isso a janela real de
// simulação por símbolo vai desde o seu first_seen até agora, não 30 dias.
//
// Trailing stop de 3% (ver strategy.trailingStopPct em runner.js): segue o
// extremo (máximo para long, mínimo para short) desde a entrada, fecha se o
// preço recuar 3% a partir daí. Verificado por high/low intracandle, tal
// como o TP dos outros backtests da pasta — não só pelo fecho.
//
// No fim, qualquer posição que continue aberta (nem trailing stop nem sinal
// dispararam) é fechada ao preço atual (mark-to-market) para dar um
// resultado total definitivo — ver flag FORCE_CLOSE_AT_END.
//
// Corre com: node src/backtests/backtest-pumpEmaSpread-live.js
const ccxt = require('ccxt');
const strat = require('../strategies/pumpEmaSpread');
const pool = require('../db/pool');

const WARMUP_CANDLES = 200; // só para as EMAs convergirem — não gera sinais aqui
const NOTIONAL = 60;
const TAKER_FEE = 0.00055;
const TRAILING_STOP_PCT = 0.10;
const TOP_N_AT_ENTRY = 10; // só símbolos com rank <= 10 no scan em que apareceram pela 1ª vez
const FORCE_CLOSE_AT_END = true;

function makeTrade(trades, symbol, side, entryPrice, entryTime, exitPrice, exitTime, qty, reason) {
  const grossPnl = side === 'long' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE;
  const pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  trades.push({ symbol, side, entryPrice, entryTime, exitPrice, exitTime, pnl: grossPnl - fee, pnlPct, reason });
}

// Só entra em candles com time >= firstSeen; antes disso as candles servem
// só de aquecimento para a EMA21 ter valor válido.
//
// Trailing stop só ATIVA depois de a posição entrar em lucro pela primeira
// vez (bar.high > entryPrice no long, bar.low < entryPrice no short) — antes
// disso não há proteção nenhuma, o movimento inicial fica livre para
// respirar. Uma vez ativo, fica sempre ativo (position.trailActive), mesmo
// que o preço volte a cair para perto da entrada.
function backtestSymbol(symbol, candles, firstSeen) {
  const trades = [];
  let position = null; // { side, entryPrice, entryTime, qty, extremePrice, trailActive }

  for (let i = WARMUP_CANDLES; i < candles.length; i++) {
    const bar = candles[i];
    if (bar.time < firstSeen) continue; // ainda em aquecimento, não é elegível para entrar

    if (position) {
      if (!position.trailActive) {
        const nowInProfit = position.side === 'long' ? bar.high > position.entryPrice : bar.low < position.entryPrice;
        if (nowInProfit) position.trailActive = true;
      }

      if (position.trailActive) {
        // Trailing stop primeiro — pode disparar intracandle antes de o sinal confirmar reversão
        position.extremePrice = position.side === 'long'
          ? Math.max(position.extremePrice, bar.high)
          : Math.min(position.extremePrice, bar.low);
        const trailPrice = position.side === 'long'
          ? position.extremePrice * (1 - TRAILING_STOP_PCT)
          : position.extremePrice * (1 + TRAILING_STOP_PCT);
        const trailHit = position.side === 'long' ? bar.low <= trailPrice : bar.high >= trailPrice;
        if (trailHit) {
          makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, trailPrice, bar.time, position.qty, 'trailing-stop');
          position = null;
          continue;
        }
      }
    }

    const window = candles.slice(Math.max(0, i - WARMUP_CANDLES), i + 1);
    const { signal } = strat.generateSignal(window, position ? position.side : null);
    const price = bar.close;

    if (!position) {
      if (signal === 'long' || signal === 'short') {
        position = { side: signal, entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, extremePrice: price, trailActive: false };
      }
      continue;
    }

    if ((position.side === 'long' && signal === 'close_long') || (position.side === 'short' && signal === 'close_short')) {
      makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, price, bar.time, position.qty, 'signal');
      position = null;
    }
  }

  let openPosition = null;
  if (position) {
    const last = candles[candles.length - 1];
    if (FORCE_CLOSE_AT_END) {
      makeTrade(trades, symbol, position.side, position.entryPrice, position.entryTime, last.close, last.time, position.qty, 'mark-to-market');
    } else {
      openPosition = { symbol, side: position.side, entryPrice: position.entryPrice, entryTime: position.entryTime, currentPrice: last.close, hoursOpen: (last.time - position.entryTime) / 3600000 };
    }
  }

  return { trades, openPosition };
}

async function main() {
  const { rows: allRows } = await pool.query(`
    WITH first_seen AS (
      SELECT symbol, MIN(scanned_at) AS ts FROM scanner_pump GROUP BY symbol
    )
    SELECT sp.symbol, fs.ts AS first_seen, sp.rank AS rank_at_first_seen
    FROM scanner_pump sp
    JOIN first_seen fs ON sp.symbol = fs.symbol AND sp.scanned_at = fs.ts
    ORDER BY fs.ts
  `);
  const rows = allRows.filter(r => r.rank_at_first_seen <= TOP_N_AT_ENTRY);
  console.log(`Símbolos com histórico real no scanner Pump 24h: ${allRows.length}`);
  console.log(`Símbolos com rank <= ${TOP_N_AT_ENTRY} no momento em que entraram: ${rows.length}`);
  console.log(rows.map(r => `${r.symbol.split('/')[0]} (#${r.rank_at_first_seen})`).join(', '));
  console.log(`Primeira sessão: ${allRows.reduce((min, r) => r.first_seen < min ? r.first_seen : min, allRows[0].first_seen).toISOString()}`);
  console.log(`Trailing stop: ${(TRAILING_STOP_PCT * 100).toFixed(0)}% (ativa só a partir do lucro) · Fecho forçado ao preço atual no fim: ${FORCE_CLOSE_AT_END ? 'sim' : 'não'}`);

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  const allTrades = [];
  const openPositions = [];
  let ok = 0, skipped = [];

  for (const r of rows) {
    const symbol = r.symbol;
    const firstSeen = new Date(r.first_seen);
    const hoursSinceFirstSeen = (Date.now() - firstSeen.getTime()) / 3600000;
    const candlesNeeded = WARMUP_CANDLES + Math.ceil(hoursSinceFirstSeen * 12) + 5;

    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, '5m', undefined, Math.min(candlesNeeded, 1000));
      const candles = ohlcv.map(([time, open, high, low, close, volume]) => ({ time: new Date(time), open, high, low, close, volume }));
      const { trades, openPosition } = backtestSymbol(symbol.split('/')[0], candles, firstSeen);
      allTrades.push(...trades);
      if (openPosition) openPositions.push(openPosition);
      ok++;
      process.stdout.write('.');
    } catch (err) {
      skipped.push(`${symbol.split('/')[0]} (${err.message})`);
      process.stdout.write('x');
    }
  }
  console.log(`\n\n${ok} símbolos processados, ${skipped.length} ignorados.\n`);

  if (openPositions.length) {
    console.log('===== POSIÇÕES AINDA ABERTAS (FORCE_CLOSE_AT_END=false) =====');
    console.table(openPositions.map(p => ({ symbol: p.symbol, side: p.side, entrada: p.entryTime.toISOString(), horasAberta: p.hoursOpen.toFixed(1) })));
  }

  const closed = allTrades;
  console.log(`===== TODOS OS TRADES (fechados por sinal, trailing stop, ou mark-to-market) =====`);
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
  }

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

  const symbolsWithAnyTrade = new Set([...openPositions.map(p => p.symbol), ...closed.map(t => t.symbol)]);
  console.log(`\nSímbolos com pelo menos 1 trade: ${symbolsWithAnyTrade.size} / ${rows.length}`);
  console.log(`Símbolos sem qualquer trade ainda (fora da banda de spread desde que entraram): ${rows.length - symbolsWithAnyTrade.size}`);

  if (skipped.length) console.log(`\nIgnorados: ${skipped.join(', ')}`);
  await pool.end();
}

main().catch(err => { console.error('Erro no backtest:', err); process.exit(1); });
