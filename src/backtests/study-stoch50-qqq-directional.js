// Estudo pedido pelo utilizador (07/09/2026): e se a Stoch50 usasse o QQQ
// como filtro DIRECIONAL — QQQ em alta => só longs, QQQ em baixa => só shorts?
// Compara com a config atual (long-only, sem filtro) e com o long+short sem
// filtro (config antes de 14/08).
//
// Universo: as 39 stocks/ETFs de produção (ver runner.js), velas 1h.
// Sinal: cruzamento de %K (SMA40 do %K bruto do Stoch K50) sobre %D (SMA11).
//   crossUp   -> entra long  / cobre short
//   crossDown -> entra short / fecha long
// TP parcial: fecha 50% a ±15% do preço de entrada (long: +15%, short: -15%).
// Sem stop-loss (igual à config de produção).
//
// Regime QQQ — 3 leituras testadas lado a lado:
//   - "na hora do trade": preço do QQQ na vela de 1h da entrada vs fecho do
//     último dia completo — exatamente o que o runner faz ao vivo
//     (getQqqPositive: vela diária a formar-se vs véspera). É a leitura pedida.
//   - "fecho do dia": direção da vela diária inteira — TEM lookahead num
//     backtest (decide trades da manhã com o fecho da tarde).
//   - "dia anterior": direção do dia -1 — 100% causal, referência conservadora.
//
// Corre com: node src/backtests/study-stoch50-qqq-directional.js [dias]
const ccxt = require('ccxt');
const { Stochastic, SMA } = require('technicalindicators');
const { fetchOHLCVPaginated } = require('./lib/ohlcv');

const DAYS = parseInt(process.argv[2], 10) || 90;
const WARMUP = 110;
const CANDLES_NEEDED = DAYS * 24 + WARMUP;
const K_LENGTH = 50, K_SMOOTH = 40, D_SMOOTH = 11;
const TP_PCT = 0.15, TP_FRACTION = 0.5;
const NOTIONAL = 60, TAKER_FEE = 0.00055;

// 39 símbolos de produção (runner.js — Stoch50.symbols)
const SYMBOLS = [
  'AAPL','ADBE','ALAB','AMZN','ARM','AXTI','BABA','BMNR','CBRS','CIEN','COHR','COIN','CRCL','CRDO','CRWV',
  'DELL','EWJ','EWT','EWY','GOOGL','HPE','HYUNDAI','IREN','KORU','LITE','LLY','LRCX','MRVL','MSFT','MU',
  'NBIS','NVDA','PLTR','QQQ','SMCI','SNDK','SOXL','TQQQ','USAR',
].map(t => ({ ticker: t, symbol: `${t}/USDT:USDT` }));

function stochSeries(candles) {
  const N = candles.length;
  const rawK = Stochastic.calculate({
    high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close),
    period: K_LENGTH, signalPeriod: 1,
  }).map(s => s.k);
  const kArr = SMA.calculate({ period: K_SMOOTH, values: rawK });
  const dArr = SMA.calculate({ period: D_SMOOTH, values: kArr });
  // alinhamento por índice de vela
  const kBy = new Array(N).fill(null);
  const dBy = new Array(N).fill(null);
  const kOff = N - kArr.length;   // kArr[m] <-> candle m+kOff
  const dOff = N - dArr.length;   // dArr[p] <-> candle p+dOff
  for (let m = 0; m < kArr.length; m++) kBy[m + kOff] = kArr[m];
  for (let p = 0; p < dArr.length; p++) dBy[p + dOff] = dArr[p];
  return { kBy, dBy };
}

// modo: { allowLong, allowShort, qqqDir: 'off'|'filterLong'|'directional', regimeFn }
// regimeFn(timeMs) -> true (QQQ+) | false (QQQ-) | null (sem dados)
function simulate(ticker, candles, mode) {
  const { kBy, dBy } = stochSeries(candles);
  const trades = [];
  let pos = null; // { side:'long'|'short', entryPrice, entryTime, qty, tpTaken }
  const start = Math.max(K_LENGTH + K_SMOOTH + D_SMOOTH + 2, 1);

  const close = (bar, price, qtyFrac, reason) => {
    const qty = pos.qty * qtyFrac;
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (price - pos.entryPrice) * qty * dir;
    const fee = (pos.entryPrice * qty + price * qty) * TAKER_FEE;
    trades.push({
      ticker, side: pos.side, entryPrice: pos.entryPrice, entryTime: pos.entryTime,
      exitPrice: price, exitTime: bar.time,
      pnl: gross - fee, pnlPct: ((price - pos.entryPrice) / pos.entryPrice) * 100 * dir, reason,
    });
    pos.qty -= qty;
    if (pos.qty <= 1e-9) pos = null;
  };

  for (let i = start; i < candles.length; i++) {
    const bar = candles[i];
    if (kBy[i] == null || dBy[i] == null || kBy[i - 1] == null || dBy[i - 1] == null) continue;
    const crossUp = kBy[i - 1] <= dBy[i - 1] && kBy[i] > dBy[i];
    const crossDown = kBy[i - 1] >= dBy[i - 1] && kBy[i] < dBy[i];
    const price = bar.close;

    // regime QQQ no momento da vela
    const qqqPos = mode.regimeFn ? mode.regimeFn(bar.time.getTime()) : null;

    // TP parcial
    if (pos && !pos.tpTaken) {
      if (pos.side === 'long') {
        const tp = pos.entryPrice * (1 + TP_PCT);
        if (bar.high >= tp) { close(bar, tp, TP_FRACTION, 'tp-parcial'); if (pos) pos.tpTaken = true; }
      } else {
        const tp = pos.entryPrice * (1 - TP_PCT);
        if (bar.low <= tp) { close(bar, tp, TP_FRACTION, 'tp-parcial'); if (pos) pos.tpTaken = true; }
      }
    }

    // saídas por sinal
    if (pos && pos.side === 'long' && crossDown) close(bar, price, 1, 'signal');
    else if (pos && pos.side === 'short' && crossUp) close(bar, price, 1, 'signal');

    if (pos) continue;

    // entradas
    let wantLong = crossUp && mode.allowLong;
    let wantShort = crossDown && mode.allowShort;
    if (mode.qqqDir === 'filterLong') {
      if (qqqPos === false) wantLong = false;           // QQQ- bloqueia long
    } else if (mode.qqqDir === 'directional') {
      if (qqqPos === false) wantLong = false;           // QQQ- => só short
      if (qqqPos === true) wantShort = false;           // QQQ+ => só long
      if (qqqPos == null) { wantLong = false; wantShort = false; } // sem dados: fica de fora
    } else if (mode.qqqDir === 'shortOverlay') {
      // long-only sempre + short só quando QQQ negativo na hora
      if (qqqPos !== false) wantShort = false;
    }

    if (wantLong) pos = { side: 'long', entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, tpTaken: false };
    else if (wantShort) pos = { side: 'short', entryPrice: price, entryTime: bar.time, qty: NOTIONAL / price, tpTaken: false };
  }
  return trades;
}

// procura binária: último elemento de `arr` (com .t crescente) com t <= alvo
function lastAtOrBefore(arr, targetMs) {
  let lo = 0, hi = arr.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= targetMs) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx >= 0 ? arr[idx] : null;
}

// Constrói as 3 funções de regime QQQ a partir das velas diárias + 1h do QQQ.
function buildRegimeFns(qqqDaily, qqq1h) {
  const daily = qqqDaily.map(d => ({ t: d.t, c: d.c, day: new Date(d.t).toISOString().slice(0, 10) }));
  const hourly = qqq1h.map(h => ({ t: h.t, c: h.c })).sort((a, b) => a.t - b.t);

  // sameday: direção da vela diária do próprio dia (fecho de hoje vs fecho de ontem) — TEM lookahead
  const sameDay = (tMs) => {
    const day = new Date(tMs).toISOString().slice(0, 10);
    const i = daily.findIndex(d => d.day === day);
    if (i <= 0) return null;
    return daily[i].c >= daily[i - 1].c;
  };
  // prevday: direção do dia anterior (fecho de ontem vs anteontem) — causal
  const prevDay = (tMs) => {
    const day = new Date(tMs).toISOString().slice(0, 10);
    const i = daily.findIndex(d => d.day === day);
    if (i <= 1) return null;
    return daily[i - 1].c >= daily[i - 2].c;
  };
  // intraday: preço do QQQ NA HORA vs fecho do último dia completo — o que o
  // runner faz ao vivo (getQqqPositive: vela diária a formar-se vs véspera)
  const intraday = (tMs) => {
    const h = lastAtOrBefore(hourly, tMs);
    if (!h) return null;
    const day = new Date(tMs).toISOString().slice(0, 10);
    // fecho do último dia com day < hoje
    let prevClose = null;
    for (let i = daily.length - 1; i >= 0; i--) { if (daily[i].day < day) { prevClose = daily[i].c; break; } }
    if (prevClose == null) return null;
    return h.c >= prevClose;
  };
  return { sameDay, prevDay, intraday };
}

function agg(trades) {
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const gW = w.reduce((a, t) => a + t.pnl, 0), gL = Math.abs(l.reduce((a, t) => a + t.pnl, 0));
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return {
    n: trades.length, w: w.length, l: l.length,
    wr: trades.length ? (w.length / trades.length) * 100 : 0,
    pnl, avg: trades.length ? pnl / trades.length : 0,
    pf: gL > 0 ? gW / gL : (gW > 0 ? Infinity : 0), dd,
    longs: trades.filter(t => t.side === 'long').length,
    shorts: trades.filter(t => t.side === 'short').length,
  };
}
const row = (label, s) => ({
  variante: label, trades: s.n, 'L/S': `${s.longs}/${s.shorts}`, 'W/L': `${s.w}/${s.l}`,
  winRate: s.wr.toFixed(1) + '%', pnlUSDT: (s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2),
  'médio': (s.avg >= 0 ? '+' : '') + s.avg.toFixed(3), pf: s.pf === Infinity ? '∞' : s.pf.toFixed(2),
  maxDD: s.dd.toFixed(1),
});

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  // ── QQQ: velas diárias + 1h ──
  const qqqDailyRaw = await fetchOHLCVPaginated(exchange, 'QQQ/USDT:USDT', '1d', DAYS + 20);
  const qqqDaily = qqqDailyRaw.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const qqq1hRaw = await fetchOHLCVPaginated(exchange, 'QQQ/USDT:USDT', '1h', CANDLES_NEEDED);
  const qqq1h = qqq1hRaw.map(([t, o, h, l, c]) => ({ t, c }));
  const { sameDay, prevDay, intraday } = buildRegimeFns(qqqDaily, qqq1h);
  console.log(`QQQ: ${qqqDaily.length} velas diárias · ${qqq1h.length} velas 1h\n`);

  console.log(`A obter velas 1h de ${SYMBOLS.length} símbolos (${CANDLES_NEEDED} cada)...`);
  const data = {};
  let ok = 0; const skip = [];
  for (const { ticker, symbol } of SYMBOLS) {
    try {
      if (!exchange.markets[symbol]) { skip.push(ticker); continue; }
      const o = await fetchOHLCVPaginated(exchange, symbol, '1h', CANDLES_NEEDED);
      data[ticker] = o.map(([time, op, hi, lo, cl, v]) => ({ time: new Date(time), open: op, high: hi, low: lo, close: cl, volume: v }));
      ok++; process.stdout.write('.');
    } catch { skip.push(ticker); process.stdout.write('x'); }
  }
  console.log(`\n${ok} ok, ${skip.length} ignorados${skip.length ? ' (' + skip.join(',') + ')' : ''}\n`);

  const cutoff = Date.now() - DAYS * 24 * 3.6e6;
  const MODES = {
    'Atual (long-only, sem filtro)':               { allowLong: true, allowShort: false, qqqDir: 'off',         regimeFn: null },
    'Long+short sem filtro (pré-14/08)':           { allowLong: true, allowShort: true,  qqqDir: 'off',         regimeFn: null },
    'Direcional — QQQ na HORA do trade (=runner)': { allowLong: true, allowShort: true,  qqqDir: 'directional', regimeFn: intraday },
    'Direcional — QQQ fecho do dia (LOOKAHEAD)':   { allowLong: true, allowShort: true,  qqqDir: 'directional', regimeFn: sameDay },
    'Direcional — QQQ dia anterior (causal)':      { allowLong: true, allowShort: true,  qqqDir: 'directional', regimeFn: prevDay },
    'Long-only + filtro QQQ na hora (só long QQQ+)': { allowLong: true, allowShort: false, qqqDir: 'filterLong', regimeFn: intraday },
    'Long sempre + short só em QQQ- na hora':        { allowLong: true, allowShort: true,  qqqDir: 'shortOverlay', regimeFn: intraday },
  };

  const results = {};
  for (const [label, mode] of Object.entries(MODES)) {
    let all = [];
    for (const [ticker, candles] of Object.entries(data)) {
      all = all.concat(simulate(ticker, candles, mode).filter(t => t.exitTime.getTime() >= cutoff));
    }
    results[label] = all;
  }

  console.log('════════════════════════════════════════════════════════');
  console.log(`Stoch50 × filtro QQQ — ${DAYS} dias, 1h, TP parcial 50%@15%, sem SL, ${ok} símbolos`);
  console.log('════════════════════════════════════════════════════════');
  console.table(Object.entries(results).map(([label, tr]) => row(label, agg(tr))));

  // detalhe do direcional "na hora" (= o que o runner faria): longs vs shorts
  const d = results['Direcional — QQQ na HORA do trade (=runner)'];
  console.log('\nDirecional "na hora do trade" — separado por lado:');
  console.table([
    row('  longs (QQQ+ na hora)', agg(d.filter(t => t.side === 'long'))),
    row('  shorts (QQQ- na hora)', agg(d.filter(t => t.side === 'short'))),
  ]);

  const fs = require('fs'), path = require('path');
  const out = path.join(__dirname, 'data', 'study-stoch50-qqq-directional-result.json');
  fs.writeFileSync(out, JSON.stringify({
    params: { DAYS, TP_PCT }, generatedAt: new Date().toISOString(),
    summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, agg(v)])),
    trades: results,
  }, null, 2));
  console.log(`\nJSON: ${out}`);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
