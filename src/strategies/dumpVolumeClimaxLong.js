// Clímax de volume numa queda · LONG — o espelho da PumpVolumeClimaxShort.
// Avaliada a cada 15 min (gestão de SL/TP), mas o sinal vem só da última vela
// de 1h FECHADA (context.candles1h, ver hourlyCandlesLimit em runner.js).
//
// Entrada (as três na vela de 1h que acabou de fechar):
//   - queda 24h > 15% (fecho vs. fecho 24 velas antes)
//   - volume da hora ≥ 10× a média das 24 horas anteriores (volume × fecho, em USDT)
//   - RSI(14) 1h ≤ 20
// Uma entrada por moeda a cada 24h; só nos primeiros 20 min depois do fecho da hora.
//
// Saídas: SL 15% no runner · TP +15% fecha tudo (sinal close_long) · fecho às 48h.
//
// Estudo 1/01–8/11/2026 (bc/freq no scratchpad da sessão; velas Bybit de 814
// moedas, entrada na abertura seguinte, stop dentro da vela 15m, comissões e
// funding, $100/trade): 322 trades, +1 522, PF 2,53, drawdown 82, jan–jun
// +1 192 · jul–nov +329. Atenção: +853 vieram de um só dia (crash de 6/02,
// 70 entradas ao mesmo tempo); sem esse dia, +669 em 252 trades.
const { RSI } = require('technicalindicators');

const STRATEGY_NAME = 'DumpVolumeClimaxLong';

const MIN_DROP_24H = 0.15;
const MIN_VOLUME_RATIO = 10;
const MAX_RSI = 20;
const TAKE_PROFIT_PCT = 0.15;
const HOUR_MS = 60 * 60 * 1000;
const ENTRY_WINDOW_MS = 20 * 60 * 1000;

// símbolo → início da vela 1h em que entrou (cooldown de 24h). Em memória:
// um restart pode repetir uma entrada, mas o runner não empilha posições.
const lastEntryBar = new Map();

function evaluateHour(candles1h, now = Date.now()) {
  const closed = (candles1h || []).filter((c) => +c.time + HOUR_MS <= now);
  if (closed.length < 40) return { ok: false, reason: 'histórico 1h insuficiente' };
  const last = closed.length - 1;
  const bar = closed[last];
  const barClose = +bar.time + HOUR_MS;
  if (now - barClose > ENTRY_WINDOW_MS) return { ok: false, reason: 'fora da janela de entrada (fecho da hora)' };

  const closes = closed.map((c) => c.close);
  const change24h = closes[last] / closes[last - 24] - 1;
  if (!(change24h < -MIN_DROP_24H)) return { ok: false, reason: `variação 24h ${(change24h * 100).toFixed(1)}% não é queda > 15%` };

  const quote = closed.map((c) => c.volume * c.close);
  const prev = quote.slice(last - 24, last);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const volumeRatio = avg > 0 ? quote[last] / avg : 0;
  if (volumeRatio < MIN_VOLUME_RATIO) return { ok: false, reason: `volume ${volumeRatio.toFixed(1)}× < 10×`, change24h };

  const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);
  if (!(rsi <= MAX_RSI)) return { ok: false, reason: `RSI ${rsi?.toFixed(1)} > 20`, change24h, volumeRatio };

  return { ok: true, barStart: +bar.time, change24h, volumeRatio, rsi };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  if (currentPosition === 'long') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= TAKE_PROFIT_PCT) {
      return { signal: 'close_long', reason: `TP ${(pnlPct * 100).toFixed(1)}% ≥ 15% — fecha tudo`, indicators: { pnlPct } };
    }
    return { signal: 'hold', reason: 'Mantém long — SL 15% · TP +15% · fecho às 48h', indicators: { pnlPct: pnlPct ?? null } };
  }
  if (currentPosition) {
    return { signal: 'hold', reason: `Posição ${currentPosition} — esta estratégia só gere longs`, indicators: {} };
  }

  const ev = evaluateHour(context.candles1h);
  const indicators = {
    change24h: ev.change24h ?? null,
    volumeRatio: ev.volumeRatio ?? null,
    rsi: ev.rsi ?? null,
  };
  if (!ev.ok) return { signal: 'hold', reason: ev.reason, indicators };

  const prevBar = context.symbol ? lastEntryBar.get(context.symbol) : undefined;
  if (prevBar != null && ev.barStart - prevBar < 24 * HOUR_MS) {
    return { signal: 'hold', reason: 'já entrou nas últimas 24h', indicators };
  }
  if (context.symbol) lastEntryBar.set(context.symbol, ev.barStart);

  return {
    signal: 'long',
    reason: `Queda ${(ev.change24h * 100).toFixed(0)}% · volume ${ev.volumeRatio.toFixed(0)}× · RSI ${ev.rsi.toFixed(0)} — SL 15% · TP +15% · 48h`,
    indicators,
  };
}

module.exports = { STRATEGY_NAME, TAKE_PROFIT_PCT, generateSignal, evaluateHour };
