// Estudo pedido pelo utilizador (04/09/2026): correr a estratégia
// Ema50BandCrossScaleOut sobre o universo REAL do scanner EMA90 (histórico
// guardado na BD, exposto em /api/scanner/history?period=90), e medir o
// efeito do CORTE DE RANKING:
//   - só entra se o símbolo estiver no top 30 do scan EMA90 mais recente
//   - idem top 20
//   - idem top 10
//   - e detalhe da banda 31-50: quantos trades positivos/negativos, quais,
//     e preços de entrada/saída.
//
// Diferente dos outros backtest-ema50BandCrossScaleOut*.js (que usam um
// snapshot fixo de 47 símbolos de 03/09): aqui o universo varia no tempo,
// conforme o ranking real do scanner em cada momento.
//
// Regras da estratégia (do cabeçalho de src/strategies/ema50BandCrossScaleOut.js,
// reimplementadas aqui para não depender de helpers desatualizados):
//   ENTRADA long, todas as condições:
//     - preço 0-3% acima da EMA50 (banda)  OU  cruzou a EMA50 para cima
//     - vela de entrada com |open->close| <= 20%
//     - BTC 4h acima da própria EMA50 (regime)
//     - [filtro deste estudo] rank do símbolo no scanner EMA90 <= N
//   SAÍDA:
//     - SL fixo -10% (do preço de entrada)
//     - preço 2% abaixo da EMA50
//     - RSI(14) > 87
//     - TP1 +28% fecha 30% · TP2 +48% fecha mais 30% · resto (40%) segura
//
// Corre com: node src/backtests/study-ema50BandCrossScaleOut-scanner-rank.js [dias]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { EMA, RSI } = require('technicalindicators');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const API = process.env.SCANNER_API || 'https://claudebot-production-d67d.up.railway.app';
const TIMEFRAME = '4h';
const BARS_PER_DAY = 6;
const WINDOW = 250;                 // velas para os indicadores
const DAYS = parseInt(process.argv[2], 10) || 80;
const NOTIONAL = 60;
const TAKER_FEE = 0.00055;

// Parâmetros da estratégia
const EMA_PERIOD = 50;
const RSI_PERIOD = 14;
const BAND_MAX_PCT = 3;
const EXIT_BAND_PCT = 2;
const RSI_EXIT_MAX = 87;
const ENTRY_CANDLE_MAX_MOVE_PCT = 20;
const SL_PCT = 0.10;
const TP_TIERS = [
  { pct: 0.28, fraction: 0.30 },
  { pct: 0.48, fraction: 0.30 },
];

const RANK_CUTOFFS = [10, 20, 30, 50, Infinity]; // Infinity = sem filtro de ranking

async function fetchScannerHistory() {
  const url = `${API}/api/scanner/history?period=90&sessions=5000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`scanner/history HTTP ${res.status}`);
  const raw = await res.json();
  const sessions = raw
    .map(s => ({
      t: new Date(s.scanned_at).getTime(),
      rankBySymbol: new Map(s.results.map(r => [r.symbol, r.rank])),
    }))
    .sort((a, b) => a.t - b.t);
  const symbols = new Set();
  sessions.forEach(s => s.rankBySymbol.forEach((_, sym) => symbols.add(sym)));
  return { sessions, symbols: [...symbols] };
}

// rank do símbolo no scan EMA90 imediatamente anterior a `tMs` (ou Infinity)
function rankAt(sessions, symbol, tMs) {
  let lo = 0, hi = sessions.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid].t <= tMs) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx < 0) return Infinity;
  return sessions[idx].rankBySymbol.get(symbol) ?? Infinity;
}

function candlesNeeded() {
  return DAYS * BARS_PER_DAY + WINDOW + 10;
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
      if (candles.length < WINDOW + 65) { skipped.push(ticker); continue; }
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

// Série booleana: BTC 4h acima da própria EMA50, alinhada aos timestamps das velas BTC
function btcRegimeSeries(btcCandles) {
  const closes = btcCandles.map(c => c.close);
  const emaArr = EMA.calculate({ period: 50, values: closes }); // len = closes.length - 49
  const offset = closes.length - emaArr.length;
  const map = new Map();
  for (let i = offset; i < closes.length; i++) {
    map.set(btcCandles[i].time, closes[i] > emaArr[i - offset]);
  }
  return map;
}

function btcBullishAt(btcMap, btcCandles, tMs) {
  // última vela BTC com time <= tMs
  let lo = 0, hi = btcCandles.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btcCandles[mid].time <= tMs) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  while (idx >= 0 && !btcMap.has(btcCandles[idx].time)) idx--;
  return idx >= 0 ? btcMap.get(btcCandles[idx].time) : true;
}

function indicatorsAt(window) {
  const closes = window.map(c => c.close);
  const emaArr = EMA.calculate({ period: EMA_PERIOD, values: closes });
  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const bar = window[window.length - 1];
  const price = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const ema50 = emaArr[emaArr.length - 1];
  const prevEma50 = emaArr[emaArr.length - 2];
  const rsi = rsiArr[rsiArr.length - 1];
  if (ema50 == null || prevEma50 == null || rsi == null) return null;

  const distPct50 = ((price - ema50) / ema50) * 100;
  const aboveNearEma50 = distPct50 > 0 && distPct50 < BAND_MAX_PCT;
  const crossUpEma50 = prevClose <= prevEma50 && price > ema50;
  const entryCandleMovePct = bar.open > 0 ? Math.abs((bar.close - bar.open) / bar.open) * 100 : 0;
  const entryCandleOk = entryCandleMovePct <= ENTRY_CANDLE_MAX_MOVE_PCT;
  const priceSignalOk = aboveNearEma50 || crossUpEma50;
  const belowEma50Exit = price < ema50 * (1 - EXIT_BAND_PCT / 100);
  const rsiOverbought = rsi > RSI_EXIT_MAX;
  return { price, ema50, rsi, distPct50, priceSignalOk, entryCandleOk, belowEma50Exit, rsiOverbought };
}

// Simula 1 símbolo, SEM filtro de ranking. Devolve 1 linha por posição, com
// rankAtEntry anexado (o corte de ranking aplica-se depois, como filtro).
function simulateSymbol(symbol, candles, sessions, btcMap, btcCandles) {
  const positions = [];
  let pos = null;
  const minCandles = EMA_PERIOD + RSI_PERIOD + 10;

  for (let i = minCandles; i < candles.length; i++) {
    const bar = candles[i];
    const price = bar.close;
    const window = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const ind = indicatorsAt(window);
    if (!ind) continue;

    if (pos) {
      // TP tiers
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
      // SL
      const lossPct = (pos.entryPrice - price) / pos.entryPrice;
      if (pos.qty > 1e-9 && lossPct >= SL_PCT) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: 'stop-loss' });
        pos.qty = 0;
      }
      // saídas por sinal
      if (pos.qty > 1e-9 && (ind.belowEma50Exit || ind.rsiOverbought)) {
        pos.exits.push({ price, time: bar.time, qty: pos.qty, tag: ind.belowEma50Exit ? 'ema50-2pct' : 'rsi87' });
        pos.qty = 0;
      }
      if (pos.qty <= 1e-9) { positions.push(finalizePos(pos)); pos = null; }
    }

    if (!pos && ind.priceSignalOk && ind.entryCandleOk) {
      const btcOk = btcBullishAt(btcMap, btcCandles, bar.time);
      if (btcOk !== false) {
        const qty = NOTIONAL / price;
        pos = {
          symbol, entryPrice: price, entryTime: bar.time, qtyInit: qty, qty,
          tpTierIndex: 0, exits: [],
          rankAtEntry: rankAt(sessions, symbol, bar.time),
        };
      }
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
    rankAtEntry: pos.rankAtEntry,
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
  console.log(`\nEstudo Ema50BandCrossScaleOut × ranking do scanner EMA90 — ${DAYS} dias, ${TIMEFRAME}\n`);

  console.log('A obter histórico do scanner EMA90...');
  const { sessions, symbols } = await fetchScannerHistory();
  console.log(`  ${sessions.length} sessões · ${new Date(sessions[0].t).toISOString().slice(0, 10)} → ${new Date(sessions[sessions.length - 1].t).toISOString().slice(0, 10)} · ${symbols.length} símbolos distintos`);

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  const btcOhlcv = await fetchOHLCVPaginated(exchange, 'BTC/USDT:USDT', TIMEFRAME, candlesNeeded());
  const btcCandles = btcOhlcv.slice(0, -1).map(([time, o, h, l, c, v]) => ({ time, open: o, high: h, low: l, close: c, volume: v }));
  const btcMap = btcRegimeSeries(btcCandles);

  console.log(`A obter velas ${TIMEFRAME} de ${symbols.length} símbolos (${candlesNeeded()} cada)...`);
  const data = await fetchUniverse(exchange, symbols);

  // janela de estudo: só posições abertas dentro dos últimos DAYS dias
  const cutoffMs = Date.now() - DAYS * 24 * 3.6e6;

  let all = [];
  for (const [symbol, candles] of Object.entries(data)) {
    const pos = simulateSymbol(symbol, candles, sessions, btcMap, btcCandles)
      .filter(p => new Date(p.entryTime).getTime() >= cutoffMs);
    all = all.concat(pos);
  }
  all.sort((a, b) => a.entryTime.localeCompare(b.entryTime));

  const rankedAtEntry = all.filter(t => Number.isFinite(t.rankAtEntry));
  console.log(`\nTotal de posições simuladas: ${all.length} · com rank EMA90 conhecido à entrada: ${rankedAtEntry.length}\n`);

  // ── 1) CORTES DE RANKING ────────────────────────────────────────
  console.log('════════════════════════════════════════════════════════');
  console.log('1) EFEITO DO CORTE DE RANKING (só entra se rank EMA90 <= N à entrada)');
  console.log('════════════════════════════════════════════════════════');
  const cutRows = RANK_CUTOFFS.map(n => {
    const sub = n === Infinity ? all : all.filter(t => t.rankAtEntry <= n);
    const s = agg(sub);
    return {
      corte: n === Infinity ? 'sem filtro' : `top ${n}`,
      trades: s.trades, wins: s.wins, losses: s.losses,
      winRate: s.winRate.toFixed(1) + '%',
      pnlUSDT: fmt(s.totalPnl),
      pnlPctMedio: fmt(s.avgPnlPct) + '%',
      pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2),
      maxDD: s.maxDD.toFixed(2),
    };
  });
  console.table(cutRows);

  // ── 2) POR FAIXA DE RANKING ─────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log('2) POR FAIXA DE RANKING À ENTRADA');
  console.log('════════════════════════════════════════════════════════');
  const bands = [[1, 10], [11, 20], [21, 30], [31, 40], [41, 50], [51, Infinity]];
  const bandRows = bands.map(([a, b]) => {
    const sub = all.filter(t => t.rankAtEntry >= a && t.rankAtEntry <= b);
    const s = agg(sub);
    return {
      faixa: b === Infinity ? '51+ / fora do top50' : `${a}-${b}`,
      trades: s.trades, wins: s.wins, losses: s.losses,
      winRate: s.trades ? s.winRate.toFixed(1) + '%' : '-',
      pnlUSDT: fmt(s.totalPnl),
      pnlPctMedio: fmt(s.avgPnlPct) + '%',
      pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2),
    };
  });
  console.table(bandRows);

  // ── 3) DETALHE DA BANDA 31-50 ───────────────────────────────────
  const band3150 = all.filter(t => t.rankAtEntry >= 31 && t.rankAtEntry <= 50)
    .sort((a, b) => b.pnl - a.pnl);
  const s3150 = agg(band3150);
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`3) DETALHE — TRADES COM RANK 31-50 À ENTRADA (${band3150.length} trades · ${s3150.wins} positivos · ${s3150.losses} negativos · win ${s3150.winRate.toFixed(1)}% · PnL ${fmt(s3150.totalPnl)} USDT)`);
  console.log('════════════════════════════════════════════════════════');
  console.table(band3150.map(t => ({
    simbolo: t.symbol,
    rank: t.rankAtEntry,
    entrada: t.entryTime,
    precoEntrada: t.entryPrice,
    saida: t.exitTime,
    precoSaida: Number(t.exitPrice.toPrecision(6)),
    'pnl%': fmt(t.pnlPct, 1),
    pnlUSDT: fmt(t.pnl),
    saidaPor: t.tags,
  })));

  // ── 4) VISÃO ALTERNATIVA: universo fixo = snapshot mais recente do scanner ──
  // (mesma metodologia dos outros backtest-ema50BandCrossScaleOut*.js, que
  // congelam um snapshot do scanner EMA90). Aqui o "top N" é a lista de
  // símbolos do último scan com profundidade >= 50; cada trade do símbolo
  // conta para o corte se o símbolo estiver nesse top N (independente do
  // rank no instante da entrada).
  const deepSession = [...sessions].reverse().find(s => s.rankBySymbol.size >= 50) || sessions[sessions.length - 1];
  const snapRank = deepSession.rankBySymbol;
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`4) UNIVERSO FIXO — snapshot do scanner EMA90 de ${new Date(deepSession.t).toISOString().slice(0, 16).replace('T', ' ')} (${snapRank.size} símbolos)`);
  console.log('════════════════════════════════════════════════════════');
  const bySnapSym = new Map();
  for (const [sym, rk] of snapRank) bySnapSym.set(sym.split('/')[0], rk);
  const snapTagged = all.map(t => ({ ...t, snapRank: bySnapSym.get(t.symbol) ?? Infinity }));
  const snapCuts = [10, 20, 30, 50, Infinity].map(n => {
    const sub = n === Infinity ? snapTagged : snapTagged.filter(t => t.snapRank <= n);
    const s = agg(sub);
    return {
      corte: n === Infinity ? 'todos os símbolos' : `top ${n} do snapshot`,
      simbolos: n === Infinity ? '—' : [...bySnapSym.entries()].filter(([, r]) => r <= n).length,
      trades: s.trades, wins: s.wins, losses: s.losses,
      winRate: s.winRate.toFixed(1) + '%',
      pnlUSDT: fmt(s.totalPnl), pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2), maxDD: s.maxDD.toFixed(2),
    };
  });
  console.table(snapCuts);

  const snap3150syms = [...bySnapSym.entries()].filter(([, r]) => r >= 31 && r <= 50).map(([s]) => s);
  const snap3150 = snapTagged.filter(t => t.snapRank >= 31 && t.snapRank <= 50).sort((a, b) => b.pnl - a.pnl);
  const s31 = agg(snap3150);
  console.log(`\nBanda 31-50 do snapshot — símbolos: ${snap3150syms.join(', ')}`);
  console.log(`${snap3150.length} trades · ${s31.wins} positivos · ${s31.losses} negativos · win ${s31.winRate.toFixed(1)}% · PnL ${fmt(s31.totalPnl)} USDT · PF ${s31.pf === Infinity ? '∞' : s31.pf.toFixed(2)}`);
  console.table(snap3150.map(t => ({
    simbolo: t.symbol, rankSnap: t.snapRank, entrada: t.entryTime, precoEntrada: t.entryPrice,
    saida: t.exitTime, precoSaida: Number(t.exitPrice.toPrecision(6)), 'pnl%': fmt(t.pnlPct, 1), pnlUSDT: fmt(t.pnl), saidaPor: t.tags,
  })));

  // dump JSON para análise posterior
  const outPath = path.join(__dirname, 'data', 'study-ema50BandCrossScaleOut-scanner-rank-result.json');
  fs.writeFileSync(outPath, JSON.stringify({
    params: { DAYS, TIMEFRAME, WINDOW, NOTIONAL, SL_PCT, TP_TIERS, EXIT_BAND_PCT, RSI_EXIT_MAX },
    cutoffs: cutRows, bands: bandRows,
    band3150: band3150,
    snapshot: { session: new Date(deepSession.t).toISOString(), cuts: snapCuts, band3150: snap3150, band3150syms: snap3150syms },
    allTrades: all,
  }, null, 2));
  console.log(`\nJSON completo: ${outPath}`);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
