// Estudo pedido pelo utilizador (25/09): correr a estratégia MaCross12x21
// sobre os últimos 30 dias, para decidir se vale a pena ligar (enabled:true)
// em produção — atualmente só corre em modo simulação/estudo.
//
// Universo: como o scanner "Top Ganhos do Mês" (scanner_period_gainers,
// symbolSource: 'gainersMonth') só começou a guardar histórico agora
// (tabela criada 25/09), NÃO há 30 dias de ranking real disponíveis. Por
// isso este estudo usa como proxy o snapshot ATUAL do Top 50 Ganhos do Mês
// (via /api/scanner/topgainers) como universo fixo para os últimos 30 dias —
// mesma metodologia da secção "UNIVERSO FIXO" de
// study-ema50BandCrossScaleOut-scanner-rank.js. O filtro de rank<=50 da
// própria estratégia fica sempre satisfeito (universo já é o top 50), por
// isso é omitido da simulação (equivalente a rank=1 para todos).
//
// Regras replicadas de src/strategies/maCross12x21.js (reimplementadas aqui,
// com a hora calculada a partir do timestamp HISTÓRICO da vela — ao contrário
// do código em produção, que usa a hora real do relógio (Date.now()) porque
// só corre ao vivo; num replay isso teria de usar sempre "agora", o que não
// faz sentido para um estudo do passado):
//   ENTRADA long (vela 15m fechada):
//     EMA12 > EMA21 · spread |12-21|/21 in (0,6% .. 1,5%)
//     + repeat: prevSpread<=0,6% OU prevEMA12<=prevEMA21 OU spread>prevSpread+0,06
//     + |close-EMA21|/EMA21 in [2% .. 4%]
//     + momentum 1h (4x15m) > 0%
//     + hora PT in [11..22], excluindo 4-10 (já coberto pelo <11)
//     + turnover ~3h >= $3M
//   GESTÃO (runner): SL 15% · TP 60% @ +44% · resto: close_long quando spread<0,5%
//
// Corre com: node src/backtests/study-maCross12x21-30d.js [dias]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const API = process.env.SCANNER_API || 'https://claudebot-production-d67d.up.railway.app';
const TIMEFRAME = '15m';
const BARS_PER_DAY = 96;
const WINDOW = 249;                 // mesmo lookback que o runner passa ao vivo (getCandles(...,250) - 1 vela em formação)
const DAYS = parseInt(process.argv[2], 10) || 30;
const NOTIONAL = 80;                // positionSize do MaCross12x21 no runner.js
const TAKER_FEE = 0.00055;

// Parâmetros da estratégia (src/strategies/maCross12x21.js)
const FAST = 12;
const SLOW = 21;
const ENTRY_DIFF_MIN = 0.6;
const ENTRY_DIFF_MAX = 1.5;
const EXIT_DIFF = 0.5;
const REPEAT_DELTA = 0.06;
const MIN_DIST_SLOW = 2;
const MAX_DIST_SLOW = 4;
const MOMENTUM_BARS = 4;
const MIN_MOMENTUM_1H = 0;
const MIN_TURNOVER_3H = 3_000_000;
const HOUR_MIN_PT = 11;
const HOUR_MAX_PT = 22;
const BLOCKED_HOURS_PT = new Set([4, 5, 6, 7, 8, 9, 10]);

// Gestão (runner.js — config da estratégia)
const SL_PCT = 0.15;
const TP_TIERS = [{ pct: 0.44, fraction: 0.60 }];

function candlesNeeded() {
  return DAYS * BARS_PER_DAY + WINDOW + 20;
}

async function fetchMonthGainersUniverse() {
  const res = await fetch(`${API}/api/scanner/topgainers`);
  if (!res.ok) throw new Error(`topgainers HTTP ${res.status}`);
  const state = await res.json();
  const list = state.resultsMonth || [];
  if (!list.length) throw new Error('Scanner Top Ganhos do Mês sem resultados — corre /api/scanner/topgainers/start primeiro');
  return { symbols: list.map(r => r.symbol), scannedAt: state.scannedAt };
}

async function fetchUniverse(exchange, symbols) {
  const total = candlesNeeded();
  const out = {};
  let ok = 0; const skipped = [];
  for (const symbol of symbols) {
    const ticker = symbol.split('/')[0];
    try {
      if (!exchange.markets[symbol]) { skipped.push(ticker); continue; }
      const ohlcv = await fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total);
      const candles = ohlcv.slice(0, -1).map(([time, open, high, low, close, volume]) => ({
        time, open, high, low, close, volume,
      }));
      if (candles.length < WINDOW + 40) { skipped.push(ticker); continue; }
      out[symbol] = candles;
      ok++;
      process.stdout.write('.');
    } catch {
      skipped.push(ticker);
      process.stdout.write('x');
    }
  }
  console.log(`\n[${TIMEFRAME}] ${ok} símbolos ok, ${skipped.length} ignorados${skipped.length ? ' (' + skipped.join(',') + ')' : ''}`);
  return out;
}

function hourInLisbonAt(tMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(tMs));
  let h = Number(parts.find(p => p.type === 'hour')?.value);
  if (h === 24) h = 0;
  return h;
}

function isHourBlockedAt(tMs) {
  const h = hourInLisbonAt(tMs);
  if (h < HOUR_MIN_PT || h > HOUR_MAX_PT) return true;
  return BLOCKED_HOURS_PT.has(h);
}

function lastEma(closes, period) {
  const arr = EMA.calculate({ period, values: closes });
  return arr.length ? arr[arr.length - 1] : null;
}
function lastEmaAt(closes, period, endIdxInclusive) {
  return lastEma(closes.slice(0, endIdxInclusive + 1), period);
}

// window = últimas WINDOW velas FECHADAS terminando na vela avaliada
function indicatorsAt(window) {
  const closes = window.map(c => c.close);
  const n = closes.length;
  if (n < SLOW + MOMENTUM_BARS + 5) return null;

  const price = closes[n - 1];
  const ema12 = lastEma(closes, FAST);
  const ema21 = lastEma(closes, SLOW);
  const prevEma12 = lastEmaAt(closes, FAST, n - 2);
  const prevEma21 = lastEmaAt(closes, SLOW, n - 2);
  if (ema12 == null || ema21 == null || prevEma12 == null || prevEma21 == null || !(ema21 > 0)) return null;

  const diffPct = (Math.abs(ema12 - ema21) / ema21) * 100;
  const prevDiffPct = (Math.abs(prevEma12 - prevEma21) / prevEma21) * 100;
  const bullishNow = ema12 > ema21;
  const bullishPrev = prevEma12 > prevEma21;
  const distSlowPct = (Math.abs(price - ema21) / ema21) * 100;

  const ref = closes[n - 1 - MOMENTUM_BARS];
  const momentum1hPct = ref > 0 ? ((price - ref) / ref) * 100 : null;

  let turnover3h = 0;
  for (let i = Math.max(0, n - 12); i < n; i++) turnover3h += window[i].volume * window[i].close;

  const tMs = window[n - 1].time;
  const spreadInBand = diffPct > ENTRY_DIFF_MIN && diffPct < ENTRY_DIFF_MAX;
  const repeatOk = prevDiffPct <= ENTRY_DIFF_MIN || !bullishPrev || diffPct > prevDiffPct + REPEAT_DELTA;
  const distOk = distSlowPct >= MIN_DIST_SLOW && distSlowPct <= MAX_DIST_SLOW;
  const momOk = momentum1hPct != null && momentum1hPct > MIN_MOMENTUM_1H;
  const turnoverOk = turnover3h >= MIN_TURNOVER_3H;
  const hourOk = !isHourBlockedAt(tMs);

  return {
    price, diffPct, distSlowPct, momentum1hPct, turnover3h,
    validEntry: bullishNow && spreadInBand && repeatOk && distOk && momOk && turnoverOk && hourOk,
  };
}

function simulateSymbol(symbol, candles) {
  const positions = [];
  let pos = null;
  const minCandles = SLOW + MOMENTUM_BARS + 8;

  for (let i = minCandles; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;
    const window = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const ind = indicatorsAt(window);
    if (!ind) continue;

    if (pos) {
      const tier = TP_TIERS[pos.tpTierIndex];
      if (tier) {
        const gainPct = (price - pos.entryPrice) / pos.entryPrice;
        if (gainPct >= tier.pct) {
          const closeQty = pos.qtyInit * tier.fraction;
          pos.exits.push({ price, time: bar.time, qty: closeQty, tag: `tp${pos.tpTierIndex + 1}` });
          pos.qty -= closeQty;
          pos.tpTierIndex++;
        }
      }
      const lossPct = (pos.entryPrice - price) / pos.entryPrice;
      if (pos.qty > 1e-9 && lossPct >= SL_PCT) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: 'stop-loss' });
        pos.qty = 0;
      }
      if (pos.qty > 1e-9 && ind.diffPct < EXIT_DIFF) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: 'close-spread' });
        pos.qty = 0;
      }
      if (pos.qty <= 1e-9) { positions.push(finalizePos(pos)); pos = null; }
    }

    if (!pos && ind.validEntry) {
      const qty = NOTIONAL / price;
      pos = { symbol, entryPrice: price, entryTime: bar.time, qtyInit: qty, qty, tpTierIndex: 0, exits: [] };
    }
  }

  if (pos) {
    const last = candles[candles.length - 1];
    pos.exits.push({ price: last.close, time: last.time, qty: pos.qty, tag: 'open-mtm' });
    pos.qty = 0;
    positions.push(finalizePos(pos, true));
  }
  return positions;
}

function finalizePos(pos, stillOpen = false) {
  const exitQty = pos.exits.reduce((a, e) => a + e.qty, 0);
  const exitVwap = pos.exits.reduce((a, e) => a + e.price * e.qty, 0) / exitQty;
  const gross = pos.exits.reduce((a, e) => a + (e.price - pos.entryPrice) * e.qty, 0);
  const fee = pos.exits.reduce((a, e) => a + (pos.entryPrice * e.qty + e.price * e.qty) * TAKER_FEE, 0);
  const pnl = gross - fee;
  const pnlPct = ((exitVwap - pos.entryPrice) / pos.entryPrice) * 100;
  return {
    symbol: pos.symbol.split('/')[0],
    entryTime: new Date(pos.entryTime).toISOString().slice(0, 16).replace('T', ' '),
    entryPrice: pos.entryPrice,
    exitTime: new Date(pos.exits[pos.exits.length - 1].time).toISOString().slice(0, 16).replace('T', ' '),
    exitPrice: exitVwap,
    pnl, pnlPct,
    tags: [...new Set(pos.exits.map(e => e.tag))].join('+'),
    stillOpen,
  };
}

function agg(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades.slice().sort((a, b) => a.exitTime.localeCompare(b.exitTime))) {
    eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak);
  }
  const avgPct = trades.length ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length : 0;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPnl, avgPnlPct: avgPct, pf, maxDD,
  };
}

function fmt(n, d = 2) { return (n >= 0 ? '+' : '') + n.toFixed(d); }

async function main() {
  console.log(`\nEstudo MaCross12x21 — últimos ${DAYS} dias, ${TIMEFRAME}\n`);

  console.log('A obter universo atual do scanner Top Ganhos do Mês...');
  const { symbols, scannedAt } = await fetchMonthGainersUniverse();
  console.log(`  ${symbols.length} símbolos · scan de ${new Date(scannedAt).toISOString()}`);
  console.log('  (usado como proxy fixo — o scanner ainda não tem 30 dias de histórico de ranking)\n');

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  console.log(`A obter velas ${TIMEFRAME} de ${symbols.length} símbolos (${candlesNeeded()} cada)...`);
  const data = await fetchUniverse(exchange, symbols);

  const cutoffMs = Date.now() - DAYS * 24 * 3.6e6;

  let all = [];
  const perSymbolCount = {};
  for (const [symbol, candles] of Object.entries(data)) {
    const pos = simulateSymbol(symbol, candles).filter(p => new Date(p.entryTime).getTime() >= cutoffMs);
    perSymbolCount[symbol.split('/')[0]] = pos.length;
    all = all.concat(pos);
  }
  all.sort((a, b) => a.entryTime.localeCompare(b.entryTime));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`RESUMO — ${all.length} posições simuladas em ${symbols.length} símbolos (Top Ganhos do Mês)`);
  console.log('════════════════════════════════════════════════════════');
  const s = agg(all);
  console.table([{
    trades: s.trades, wins: s.wins, losses: s.losses,
    winRate: s.winRate.toFixed(1) + '%',
    pnlUSDT: fmt(s.totalPnl),
    pnlPctMedio: fmt(s.avgPnlPct) + '%',
    pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2),
    maxDD: s.maxDD.toFixed(2),
    notionalPorTrade: NOTIONAL,
  }]);

  console.log('\n════════════════════════════════════════════════════════');
  console.log('POR MOTIVO DE SAÍDA');
  console.log('════════════════════════════════════════════════════════');
  const tagGroups = {};
  for (const t of all) {
    const lastTag = t.tags.split('+').pop();
    (tagGroups[lastTag] ??= []).push(t);
  }
  console.table(Object.entries(tagGroups).map(([tag, trades]) => {
    const g = agg(trades);
    return { motivo: tag, trades: g.trades, winRate: g.winRate.toFixed(1) + '%', pnlUSDT: fmt(g.totalPnl) };
  }));

  if (all.length) {
    console.log('\n════════════════════════════════════════════════════════');
    console.log('TODOS OS TRADES');
    console.log('════════════════════════════════════════════════════════');
    console.table(all.map(t => ({
      simbolo: t.symbol, entrada: t.entryTime, precoEntrada: t.entryPrice,
      saida: t.exitTime, precoSaida: Number(t.exitPrice.toPrecision(6)),
      'pnl%': fmt(t.pnlPct, 1), pnlUSDT: fmt(t.pnl), saidaPor: t.tags, aberto: t.stillOpen ? 'sim' : '',
    })));
  } else {
    console.log('\nNenhum trade simulado no período — a condição de entrada não se verificou nestes símbolos/dias.');
  }

  const outPath = path.join(__dirname, 'data', 'study-maCross12x21-30d-result.json');
  fs.writeFileSync(outPath, JSON.stringify({
    params: { DAYS, TIMEFRAME, WINDOW, NOTIONAL, SL_PCT, TP_TIERS },
    universo: { symbols, scannedAt },
    resumo: s, porSimbolo: perSymbolCount, allTrades: all,
  }, null, 2));
  console.log(`\nJSON completo: ${outPath}`);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
