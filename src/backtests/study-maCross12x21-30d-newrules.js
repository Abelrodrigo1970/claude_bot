// Estudo pedido pelo utilizador (27/09): repete o estudo de 30 dias da
// MaCross12x21, mas já com as regras novas aplicadas em produção nesse
// mesmo dia (ver src/strategies/maCross12x21.js e o bloco da estratégia em
// src/services/runner.js):
//   ENTRADA: igual + preço acima da EMA70(1h)
//   SAÍDA (fecho TOTAL, sem TP parcial nem saída por compressão de spread):
//     - SL 15% (checado em 1º lugar, tal como no runner ao vivo — a
//       estratégia só é chamada depois de o SL não disparar nesse ciclo)
//     - lucro >= +78% — fecha tudo
//     - preço fecha abaixo da EMA70(1h) — fecha tudo
//
// Universo: snapshot atual do Top 50 Ganhos do Mês (mesma limitação do
// estudo original — o scanner ainda não tem 30 dias de histórico de rank).
//
// Corre com: node src/backtests/study-maCross12x21-30d-newrules.js [dias]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const API = process.env.SCANNER_API || 'https://claudebot-production-d67d.up.railway.app';
const TIMEFRAME = '15m';
const BARS_PER_DAY = 96;
const WINDOW = 249; // mesmo lookback que o runner passa ao vivo (getCandles(...,250) - 1 vela em formação)
const DAYS = parseInt(process.argv[2], 10) || 30;
const NOTIONAL = 80; // positionSize do MaCross12x21 no runner.js
const TAKER_FEE = 0.00055;

// Parâmetros da estratégia (src/strategies/maCross12x21.js)
const FAST = 12;
const SLOW = 21;
const ENTRY_DIFF_MIN = 0.6;
const ENTRY_DIFF_MAX = 1.5;
const REPEAT_DELTA = 0.06;
const MIN_DIST_SLOW = 2;
const MAX_DIST_SLOW = 4;
const MOMENTUM_BARS = 4;
const MIN_MOMENTUM_1H = 0;
const MIN_TURNOVER_3H = 3_000_000;
const HOUR_MIN_PT = 11;
const HOUR_MAX_PT = 22;
const BLOCKED_HOURS_PT = new Set([4, 5, 6, 7, 8, 9, 10]);

// Gestão nova (27/09)
const SL_PCT = 0.15;
const TAKE_PROFIT_FULL_PCT = 0.78;

// Filtro EMA70(1h)
const EMA70_1H_TIMEFRAME = '1h';
const EMA70_PERIOD = 70;
const EMA70_1H_BARS_PER_DAY = 24;
const EMA70_WARMUP_BARS = EMA70_PERIOD + 50;

function candlesNeeded15m() { return DAYS * BARS_PER_DAY + WINDOW + 20; }
function candlesNeeded1h()  { return DAYS * EMA70_1H_BARS_PER_DAY + EMA70_WARMUP_BARS; }

async function fetchMonthGainersUniverse() {
  const res = await fetch(`${API}/api/scanner/topgainers`);
  if (!res.ok) throw new Error(`topgainers HTTP ${res.status}`);
  const state = await res.json();
  const list = state.resultsMonth || [];
  if (!list.length) throw new Error('Scanner Top Ganhos do Mês sem resultados — corre /api/scanner/topgainers/start primeiro');
  return { symbols: list.map(r => r.symbol), scannedAt: state.scannedAt };
}

async function fetchUniverse(exchange, symbols) {
  const total15 = candlesNeeded15m();
  const total1h = candlesNeeded1h();
  const out = {};
  let ok = 0; const skipped = [];
  for (const symbol of symbols) {
    const ticker = symbol.split('/')[0];
    try {
      if (!exchange.markets[symbol]) { skipped.push(ticker); continue; }
      const [ohlcv15, ohlcv1h] = await Promise.all([
        fetchOHLCVPaginated(exchange, symbol, TIMEFRAME, total15),
        fetchOHLCVPaginated(exchange, symbol, EMA70_1H_TIMEFRAME, total1h),
      ]);
      const candles15 = ohlcv15.slice(0, -1).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
      const candles1h = ohlcv1h.slice(0, -1).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
      if (candles15.length < WINDOW + 40 || candles1h.length < EMA70_WARMUP_BARS) { skipped.push(ticker); continue; }
      out[symbol] = { candles15, candles1h };
      ok++;
      process.stdout.write('.');
    } catch {
      skipped.push(ticker);
      process.stdout.write('x');
    }
  }
  console.log(`\n${ok} símbolos ok, ${skipped.length} ignorados${skipped.length ? ' (' + skipped.join(',') + ')' : ''}`);
  return out;
}

function hourInLisbonAt(tMs) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: 'numeric', hour12: false }).formatToParts(new Date(tMs));
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

function ema70Series(candles1h) {
  const closes = candles1h.map(c => c.close);
  const emaArr = EMA.calculate({ period: EMA70_PERIOD, values: closes });
  const offset = closes.length - emaArr.length;
  const map = new Map();
  for (let i = offset; i < closes.length; i++) map.set(candles1h[i].time, emaArr[i - offset]);
  return map;
}
function ema70At(ema70Map, candles1h, tMs) {
  let lo = 0, hi = candles1h.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles1h[mid].time <= tMs) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  while (idx >= 0 && !ema70Map.has(candles1h[idx].time)) idx--;
  return idx >= 0 ? ema70Map.get(candles1h[idx].time) : null;
}

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
    price, time: tMs,
    validEntryBase: bullishNow && spreadInBand && repeatOk && distOk && momOk && turnoverOk && hourOk,
  };
}

function simulateSymbol(symbol, candles15, candles1h, ema70Map) {
  const positions = [];
  let pos = null;
  const minCandles = SLOW + MOMENTUM_BARS + 8;

  for (let i = minCandles; i < candles15.length; i++) {
    const bar = candles15[i];
    const price = bar.close;
    const window = candles15.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const ind = indicatorsAt(window);
    if (!ind) continue;

    const ema70 = ema70At(ema70Map, candles1h, ind.time);
    const aboveEma70 = ema70 != null ? price > ema70 : null;

    if (pos) {
      const gainPct = (price - pos.entryPrice) / pos.entryPrice;
      const lossPct = (pos.entryPrice - price) / pos.entryPrice;

      // Mesma ordem de prioridade do runner ao vivo: SL é checado ANTES do
      // sinal da estratégia (se disparar, a estratégia nem chega a ser
      // chamada nesse ciclo); dentro do sinal, TP 78% tem prioridade sobre
      // o fecho por EMA70 (ver generateSignal em maCross12x21.js).
      if (lossPct >= SL_PCT) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: 'stop-loss' });
        pos.qty = 0;
      } else if (gainPct >= TAKE_PROFIT_FULL_PCT) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: 'take-profit-78' });
        pos.qty = 0;
      } else if (aboveEma70 === false) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: 'ema70-exit' });
        pos.qty = 0;
      }

      if (pos.qty <= 1e-9) { positions.push(finalizePos(pos)); pos = null; }
    }

    if (!pos && ind.validEntryBase && aboveEma70 === true) {
      const qty = NOTIONAL / price;
      pos = { symbol, entryPrice: price, entryTime: bar.time, qtyInit: qty, qty, exits: [] };
    }
  }

  if (pos) {
    const last = candles15[candles15.length - 1];
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
  console.log(`\nEstudo MaCross12x21 (regras novas: entrada EMA70(1h) + saída TP78%/EMA70/SL15%) — últimos ${DAYS} dias\n`);

  console.log('A obter universo atual do scanner Top Ganhos do Mês...');
  const { symbols, scannedAt } = await fetchMonthGainersUniverse();
  console.log(`  ${symbols.length} símbolos · scan de ${new Date(scannedAt).toISOString()}\n`);

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  console.log(`A obter velas 15m (${candlesNeeded15m()}) + 1h (${candlesNeeded1h()}) de ${symbols.length} símbolos...`);
  const data = await fetchUniverse(exchange, symbols);

  const cutoffMs = Date.now() - DAYS * 24 * 3.6e6;

  let all = [];
  const perSymbol = {};
  for (const [symbol, { candles15, candles1h }] of Object.entries(data)) {
    const ema70Map = ema70Series(candles1h);
    const pos = simulateSymbol(symbol, candles15, candles1h, ema70Map).filter(p => new Date(p.entryTime).getTime() >= cutoffMs);
    perSymbol[symbol.split('/')[0]] = pos.length;
    all = all.concat(pos);
  }
  all.sort((a, b) => a.entryTime.localeCompare(b.entryTime));

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`RESUMO — ${all.length} posições simuladas em ${symbols.length} símbolos (regras novas)`);
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
    console.log('\nNenhum trade simulado no período.');
  }

  const outPath = path.join(__dirname, 'data', 'study-maCross12x21-30d-newrules-result.json');
  fs.writeFileSync(outPath, JSON.stringify({
    params: { DAYS, TIMEFRAME, WINDOW, NOTIONAL, SL_PCT, TAKE_PROFIT_FULL_PCT, EMA70_PERIOD },
    universo: { symbols, scannedAt },
    resumo: s, porSimbolo: perSymbol, allTrades: all,
  }, null, 2));
  console.log(`\nJSON completo: ${outPath}`);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
