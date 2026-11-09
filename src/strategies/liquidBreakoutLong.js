// Rompimento líquido · LONG — "versão B" do estudo de pumps de 09/11.
// Avaliada a cada 15 min (gestão de SL/TP), mas o sinal vem só da última vela
// de 30m FECHADA (context.signalCandles, ver signalCandles em runner.js).
//
// Entrada (todas na vela de 30m que acabou de fechar):
//   - volume 24h ≥ $50M (soma volume × fecho das 48 velas, incluindo esta)
//   - fecho acima do máximo dos 7 dias anteriores (336 velas, sem esta)
//   - vela a subir ≥ 1,5% (fecho vs. abertura)
//   - volume da vela ≥ 3× a média das 48 velas anteriores
//   - RSI(14) 30m ≥ 75
// Uma entrada por moeda a cada 24h; só nos primeiros 14 min depois do fecho
// da vela (o cron de 15m corre ~:03/:33 logo a seguir aos fechos de 30m).
//
// Saídas: SL 20% no runner · 30% a +10% (takeProfitTiers) · resto a +45%
// (sinal close_long) · fecho às 48h.
//
// Estudo 1/01–8/11/2026 (bc/pump no scratchpad da sessão; velas Bybit 15m de
// 733 moedas, entrada na abertura seguinte, stop dentro da vela 15m, comissões
// e funding, $100/trade): 483 trades, +1 780, PF 1,80, drawdown 136, jan–jun
// +1 216 · jul–nov +564; sem as 10 melhores moedas +866. 55% dos trades
// chegam a +10% (mediana 4h), 18% a +40%.
const { RSI } = require('technicalindicators');

const STRATEGY_NAME = 'LiquidBreakoutLong';

const BAR_MS = 30 * 60 * 1000;
const BARS_24H = 48;
const BARS_7D = 336;
const MIN_TURNOVER_24H = 50e6;
const MIN_BAR_RISE = 0.015;
const MIN_VOLUME_RATIO = 3;
const MIN_RSI = 75;
const FINAL_TP_PCT = 0.45;
const ENTRY_WINDOW_MS = 14 * 60 * 1000;

// símbolo → início da vela 30m em que entrou (cooldown de 24h). Em memória:
// um restart pode repetir uma entrada, mas o runner não empilha posições.
const lastEntryBar = new Map();

function evaluateBar(candles30m, now = Date.now()) {
  const closed = (candles30m || []).filter((c) => +c.time + BAR_MS <= now);
  if (closed.length < BARS_7D + 30) return { ok: false, reason: 'histórico 30m insuficiente' };
  const last = closed.length - 1;
  const bar = closed[last];
  if (now - (+bar.time + BAR_MS) > ENTRY_WINDOW_MS) return { ok: false, reason: 'fora da janela de entrada (fecho da vela 30m)' };

  const quote = closed.map((c) => c.volume * c.close);
  const turnover24h = quote.slice(last - BARS_24H + 1).reduce((a, b) => a + b, 0);
  if (turnover24h < MIN_TURNOVER_24H) return { ok: false, reason: `volume 24h $${(turnover24h / 1e6).toFixed(0)}M < $50M` };

  const high7d = Math.max(...closed.slice(last - BARS_7D, last).map((c) => c.high));
  const breakout = bar.close / high7d - 1;
  if (!(breakout > 0)) return { ok: false, reason: `abaixo do máximo de 7 dias (${(breakout * 100).toFixed(1)}%)`, turnover24h };

  const barRise = bar.close / bar.open - 1;
  if (barRise < MIN_BAR_RISE) return { ok: false, reason: `vela +${(barRise * 100).toFixed(1)}% < 1,5%`, turnover24h, breakout };

  const prev = quote.slice(last - BARS_24H, last);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const volumeRatio = avg > 0 ? quote[last] / avg : 0;
  if (volumeRatio < MIN_VOLUME_RATIO) return { ok: false, reason: `volume ${volumeRatio.toFixed(1)}× < 3×`, turnover24h, breakout, barRise };

  const rsi = RSI.calculate({ period: 14, values: closed.map((c) => c.close) }).at(-1);
  if (!(rsi >= MIN_RSI)) return { ok: false, reason: `RSI ${rsi?.toFixed(1)} < 75`, turnover24h, breakout, barRise, volumeRatio };

  return { ok: true, barStart: +bar.time, turnover24h, breakout, barRise, volumeRatio, rsi };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  if (currentPosition === 'long') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= FINAL_TP_PCT) {
      return { signal: 'close_long', reason: `TP ${(pnlPct * 100).toFixed(1)}% ≥ 45% — fecha o resto`, indicators: { pnlPct } };
    }
    return { signal: 'hold', reason: 'Mantém long — SL 20% · 30% a +10% · resto a +45% · fecho às 48h', indicators: { pnlPct: pnlPct ?? null } };
  }
  if (currentPosition) {
    return { signal: 'hold', reason: `Posição ${currentPosition} — esta estratégia só gere longs`, indicators: {} };
  }

  const ev = evaluateBar(context.signalCandles);
  const indicators = {
    turnover24h: ev.turnover24h ?? null,
    breakout7d: ev.breakout ?? null,
    barRise: ev.barRise ?? null,
    volumeRatio: ev.volumeRatio ?? null,
    rsi: ev.rsi ?? null,
  };
  if (!ev.ok) return { signal: 'hold', reason: ev.reason, indicators };

  const prevBar = context.symbol ? lastEntryBar.get(context.symbol) : undefined;
  if (prevBar != null && ev.barStart - prevBar < 24 * 60 * 60 * 1000) {
    return { signal: 'hold', reason: 'já entrou nas últimas 24h', indicators };
  }
  if (context.symbol) lastEntryBar.set(context.symbol, ev.barStart);

  return {
    signal: 'long',
    reason: `Rompe máx 7d (+${(ev.breakout * 100).toFixed(1)}%) · vela +${(ev.barRise * 100).toFixed(1)}% · volume ${ev.volumeRatio.toFixed(0)}× · RSI ${ev.rsi.toFixed(0)} · $${(ev.turnover24h / 1e6).toFixed(0)}M/24h — SL 20% · 30% a +10% · resto a +45% · 48h`,
    indicators,
  };
}

module.exports = { STRATEGY_NAME, FINAL_TP_PCT, generateSignal, evaluateBar };
