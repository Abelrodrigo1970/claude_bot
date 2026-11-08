// Clímax de volume num pump · SHORT. Avaliada a cada 15 min (gestão de SL/TP),
// mas o sinal vem só da última vela de 1h FECHADA (context.candles1h, ver
// hourlyCandlesLimit em runner.js).
//
// Entrada (as quatro na vela de 1h que acabou de fechar):
//   - subida 24h > 20% (fecho vs. fecho 24 velas antes)
//   - volume da hora ≥ 20× a média das 24 horas anteriores (volume × fecho, em USDT)
//   - RSI(14) 1h ≥ 80
//   - a moeda disparou (>20% em 24h, no máx. 1 por dia) menos de 3 vezes nos
//     30 dias anteriores — as "repetentes" (ex: lista Frequentes do Pump 24h)
//     continuam a subir e o short nelas perde
// Uma entrada por moeda a cada 24h; só nos primeiros 20 min depois do fecho da hora.
//
// Saídas no runner: SL 15% · 50% a −25% (takeProfitTiers) · resto às 48h.
//
// Estudo 1/01–8/11/2026 (bc/freq no scratchpad da sessão; velas Bybit de 814
// moedas, entrada na abertura seguinte, stop dentro da vela 15m, comissões e
// funding, $100/trade): 454 trades, +1 407, PF 1,53, drawdown 135, jan–jun
// +836 · jul–nov +570. As mesmas regras nas moedas que dispararam ≥3 vezes:
// 473 trades, −114.
const { RSI } = require('technicalindicators');

const STRATEGY_NAME = 'PumpVolumeClimaxShort';

const MIN_RISE_24H = 0.20;
const MIN_VOLUME_RATIO = 20;
const MIN_RSI = 80;
const MAX_PRIOR_PUMPS_30D = 2;
const HOUR_MS = 60 * 60 * 1000;
const ENTRY_WINDOW_MS = 20 * 60 * 1000;

// símbolo → início da vela 1h em que entrou (cooldown de 24h). Em memória:
// um restart pode repetir uma entrada, mas o runner não empilha posições.
const lastEntryBar = new Map();

// Pumps (>20% em 24h) com 24h de intervalo mínimo, contados nas 720 velas
// antes de `lastIdx` — o equivalente causal de "aparece muitas vezes no Pump 24h".
function priorPumpCount(closes, lastIdx) {
  let count = 0;
  let lastEvent = -Infinity;
  for (let i = 24; i < lastIdx; i++) {
    if (closes[i] / closes[i - 24] - 1 <= MIN_RISE_24H) continue;
    if (i - lastEvent < 24) continue;
    lastEvent = i;
    if (i >= lastIdx - 720) count++;
  }
  return count;
}

function evaluateHour(candles1h, now = Date.now()) {
  const closed = (candles1h || []).filter((c) => +c.time + HOUR_MS <= now);
  if (closed.length < 224) return { ok: false, reason: 'histórico 1h insuficiente' };
  const last = closed.length - 1;
  const bar = closed[last];
  const barClose = +bar.time + HOUR_MS;
  if (now - barClose > ENTRY_WINDOW_MS) return { ok: false, reason: 'fora da janela de entrada (fecho da hora)' };

  const closes = closed.map((c) => c.close);
  const rise24h = closes[last] / closes[last - 24] - 1;
  if (!(rise24h > MIN_RISE_24H)) return { ok: false, reason: `subida 24h ${(rise24h * 100).toFixed(1)}% ≤ 20%` };

  const quote = closed.map((c) => c.volume * c.close);
  const prev = quote.slice(last - 24, last);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const volumeRatio = avg > 0 ? quote[last] / avg : 0;
  if (volumeRatio < MIN_VOLUME_RATIO) return { ok: false, reason: `volume ${volumeRatio.toFixed(1)}× < 20×`, rise24h };

  const rsi = RSI.calculate({ period: 14, values: closes }).at(-1);
  if (!(rsi >= MIN_RSI)) return { ok: false, reason: `RSI ${rsi?.toFixed(1)} < 80`, rise24h, volumeRatio };

  const pumps = priorPumpCount(closes, last);
  if (pumps > MAX_PRIOR_PUMPS_30D) return { ok: false, reason: `repetente: ${pumps} pumps em 30 dias`, rise24h, volumeRatio, rsi };

  return { ok: true, barStart: +bar.time, rise24h, volumeRatio, rsi, pumps };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  if (currentPosition === 'short') {
    return { signal: 'hold', reason: 'Mantém short — SL 15% · 50% a −25% · resto às 48h', indicators: {} };
  }
  if (currentPosition) {
    return { signal: 'hold', reason: `Posição ${currentPosition} — esta estratégia só gere shorts`, indicators: {} };
  }

  const ev = evaluateHour(context.candles1h);
  const indicators = {
    rise24h: ev.rise24h ?? null,
    volumeRatio: ev.volumeRatio ?? null,
    rsi: ev.rsi ?? null,
    priorPumps30d: ev.pumps ?? null,
  };
  if (!ev.ok) return { signal: 'hold', reason: ev.reason, indicators };

  const prevBar = context.symbol ? lastEntryBar.get(context.symbol) : undefined;
  if (prevBar != null && ev.barStart - prevBar < 24 * HOUR_MS) {
    return { signal: 'hold', reason: 'já entrou nas últimas 24h', indicators };
  }
  if (context.symbol) lastEntryBar.set(context.symbol, ev.barStart);

  return {
    signal: 'short',
    reason: `Pump +${(ev.rise24h * 100).toFixed(0)}% · volume ${ev.volumeRatio.toFixed(0)}× · RSI ${ev.rsi.toFixed(0)} · ${ev.pumps} pumps/30d — SL 15% · 50% a −25% · 48h`,
    indicators,
  };
}

module.exports = { STRATEGY_NAME, generateSignal, evaluateHour, priorPumpCount };
