// Rumer's Box semanal · padrão b · LONG (contratrade) — pedido do utilizador 09/10.
// Universo: todos os perpétuos USDT de cripto (sem ações/ETFs/commodities/forex),
// pré-filtrados uma vez por dia aos pares em padrão b (ver rumersWeeklyB em runner.js).
//
// Caixa = máximo/mínimo da semana anterior (2ª a domingo, UTC).
// Padrão b = o meio da caixa está mais de 6% abaixo do fecho de 3 semanas antes
// do início da caixa (o preço caiu e consolidou).
//
// Entrada LONG (últimas duas velas 15m FECHADAS):
//   fecho > máximo da caixa · vela anterior fechou dentro da caixa
//   + quebra < 1% acima do máximo · amplitude da caixa 1,5–19%
//   + BTC acima da EMA50 da última vela diária fechada (context.btcAboveEma50Daily)
//   + 1 entrada por caixa e por par (enteredBoxes)
//
// Gestão (runner): SL 6% · TP +25% fecha tudo (sinal close_long da estratégia)
// · fecho às 48h (maxHoldHours).
//
// Estudo 1 jan–9 out (strategy-lab-bot/rumers_pb_week.py --btc-daily, só cripto,
// $100/trade, IS jan–jun / OOS jul–out): 1012 trades, PF 1,51 / 2,67, P&L +2079,
// drawdown 388, win rate 50%. Saídas avaliadas em velas de 15m (SL antes de TP).
const { computeBoxLevels } = require('../services/rumersBox');

const STRATEGY_NAME = 'RumersBoxWeeklyB';

const TREND_LOOKBACK_WEEKS = 3;
const TREND_MAX_PCT = -6;      // b: queda de mais de 6%
const BREAK_MAX_PCT = 1;
const RANGE_MIN_PCT = 1.5;
const RANGE_MAX_PCT = 19;
const TAKE_PROFIT_FULL_PCT = 0.25;
const BAR_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 'SYMBOL|periodKey' das caixas onde já houve entrada (recarregado da BD ao
// arrancar — ver loadRumersWeeklyBEntries em runner.js)
const enteredBoxes = new Set();

function markEntered(symbol, periodKey) { enteredBoxes.add(`${symbol}|${periodKey}`); }

function periodKeyOf(ms) {
  // 2ª feira da semana ANTERIOR à de `ms` — é a chave da caixa usada nessa semana
  const d = new Date(ms);
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday = day0 - ((new Date(day0).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday - 7 * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Caixa semanal + tendência a partir de velas DIÁRIAS ({ time, high, low, close }).
 * Devolve null se o histórico não cobrir a semana anterior e as 3 semanas antes.
 */
function computeWeeklyBox(dailyCandles, nowMs = Date.now()) {
  const daily = dailyCandles.map((c) => ({ time: +c.time, high: c.high, low: c.low, close: c.close }));
  const levels = computeBoxLevels(daily, 'week', nowMs);
  if (!levels) return null;
  const refDay = levels.periodStart - TREND_LOOKBACK_WEEKS * 7 * DAY_MS - DAY_MS;
  const ref = daily.find((c) => c.time === refDay);
  if (!ref || !(ref.close > 0)) return null;
  return {
    high: levels.prevHigh,
    low: levels.prevLow,
    rangePct: levels.boxRangePct,
    trendPct: (levels.prevMid / ref.close - 1) * 100,
    periodKey: levels.periodKey,
  };
}

/** Padrão b com amplitude aceite — usado para pré-filtrar o universo uma vez por dia. */
function isCandidate(box) {
  return !!box && box.trendPct < TREND_MAX_PCT && box.rangePct >= RANGE_MIN_PCT && box.rangePct <= RANGE_MAX_PCT;
}

function generateSignal(candles, currentPosition = null, context = {}) {
  const box = context.weeklyBox || null;
  const ind = { box, btcAboveEma50Daily: context.btcAboveEma50Daily ?? null };

  if (currentPosition === 'long') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= TAKE_PROFIT_FULL_PCT) {
      return { signal: 'close_long', reason: `TP +${(pnlPct * 100).toFixed(1)}% ≥ 25% — fecha tudo`, indicators: ind };
    }
    return { signal: 'hold', reason: 'Mantém long — TP +25% · SL 6% · fecho às 48h', indicators: ind };
  }

  if (!box) return { signal: 'none', reason: 'Sem caixa semanal (histórico curto)', indicators: ind };
  const now = Date.now();
  const closed = (candles || []).filter((c) => +c.time + BAR_MS <= now);
  if (closed.length < 2) return { signal: 'none', reason: 'Velas 15m insuficientes', indicators: ind };
  const curr = closed[closed.length - 1];
  const prev = closed[closed.length - 2];
  const breakPct = (curr.close / box.high - 1) * 100;
  Object.assign(ind, { close: curr.close, prevClose: prev.close, breakPct });

  const crossed = curr.close > box.high && prev.close <= box.high && prev.close >= box.low;
  if (!crossed) {
    return { signal: 'hold', reason: `Dentro/fora da caixa ${box.low}–${box.high} sem quebra nesta vela`, indicators: ind };
  }
  const blocks = [];
  if (!isCandidate(box)) blocks.push(`caixa ${box.rangePct.toFixed(1)}% · tendência ${box.trendPct.toFixed(1)}% fora do padrão b`);
  if (!(breakPct < BREAK_MAX_PCT)) blocks.push(`quebra ${breakPct.toFixed(2)}% ≥ 1%`);
  if (context.btcAboveEma50Daily !== true) blocks.push('BTC abaixo (ou sem dados) da EMA50 diária');
  if (enteredBoxes.has(`${context.symbol}|${box.periodKey}`)) blocks.push(`já entrou na caixa ${box.periodKey}`);
  if (blocks.length) return { signal: 'hold', reason: `Quebra da caixa semanal, mas ${blocks.join(' · ')}`, indicators: ind };

  if (context.symbol) markEntered(context.symbol, box.periodKey);
  return {
    signal: 'long',
    reason: `Quebra do máximo da semana ${box.periodKey} (+${breakPct.toFixed(2)}%) · padrão b ${box.trendPct.toFixed(1)}% · caixa ${box.rangePct.toFixed(1)}% · BTC > EMA50 1d`,
    indicators: ind,
  };
}

module.exports = {
  STRATEGY_NAME,
  generateSignal,
  computeWeeklyBox,
  isCandidate,
  markEntered,
  periodKeyOf,
};
