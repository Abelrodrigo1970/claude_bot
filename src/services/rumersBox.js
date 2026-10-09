// Rumer's Box — port do detector partilhado pelo utilizador (09/10), com a
// caixa generalizada a dia / semana / mês anteriores.
//
//   Caixa  = máximo/mínimo do período anterior FECHADO (dia, semana ou mês, UTC)
//   Sinal  = LONG quando a última vela 15m FECHADA fecha acima do máximo da
//            caixa e a vela 15m anterior fechou dentro da caixa
//   Filtro = amplitude da caixa ((high − low) / meio) dentro de [min, max]%
//   Níveis = SL −12% · TP1 +65% (50% da posição) · fecho às 72h — só
//            informativos aqui, o scanner não abre posições
//
// Diferenças em relação ao original:
//   - "vela em formação" decidida pelo timestamp e não por "a última do array
//     é sempre a em formação" (o original descartava uma vela fechada se o
//     feed só trouxesse velas fechadas, e aí o PDH passava a ser o de anteontem)
//   - caixas semanal/mensal derivadas das velas DIÁRIAS (as velas 1d da Bybit
//     começam às 00:00 UTC, alinhadas com a 2ª feira e com o dia 1), por isso
//     um só pedido de velas diárias por símbolo dá os três níveis
//   - semana/mês só contam se o histórico cobrir o período inteiro (listagens
//     recentes ficam de fora em vez de terem uma caixa parcial)

const DAY_MS = 24 * 60 * 60 * 1000;
const BAR_15M_MS = 15 * 60 * 1000;

// Amplitude aceite por tipo de caixa. 'day' = valores do código original;
// semana/mês calibrados (09/10, 784 perpétuos USDT) para deixar passar a
// mesma fatia do universo que o filtro diário deixa — o 0,8–12% diário exclui
// ~0,6% dos pares por baixo e ~28% por cima; os mesmos percentis dão
// 1,4–18,6% na semana e 4,5–47,7% no mês.
const RUMERS_BOX_DEFAULTS = {
  requireInsideBeforeBreak: true,
  boxRangePct: {
    day:   { min: 0.8, max: 12 },
    week:  { min: 1.5, max: 19 },
    month: { min: 4.5, max: 48 },
  },
  stopLossPct: 0.12,
  tp1Pct: 0.65,
  tp1Position: 50,
  closeAfterHours: 72,
};

const BOX_TYPES = ['day', 'week', 'month'];

function startOfUTCDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function startOfUTCWeek(ms) {
  const day0 = startOfUTCDay(ms);
  const dow = new Date(day0).getUTCDay(); // 0 = domingo
  return day0 - ((dow + 6) % 7) * DAY_MS;  // 2ª feira 00:00 UTC
}
function startOfUTCMonth(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function prevMonthStart(ms) {
  const d = new Date(startOfUTCMonth(ms));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
}

/** [início, fim) do período ANTERIOR ao que contém `nowMs`. */
function previousPeriod(type, nowMs) {
  if (type === 'day') {
    const end = startOfUTCDay(nowMs);
    return { start: end - DAY_MS, end };
  }
  if (type === 'week') {
    const end = startOfUTCWeek(nowMs);
    return { start: end - 7 * DAY_MS, end };
  }
  const end = startOfUTCMonth(nowMs);
  return { start: prevMonthStart(nowMs), end };
}

/**
 * Níveis da caixa a partir de velas DIÁRIAS ({ time, high, low } com time em
 * ms ou Date, ordem ascendente). Usa só velas inteiramente dentro do período
 * anterior; devolve null se o histórico não cobrir o período todo.
 */
function computeBoxLevels(dailyCandles, type, nowMs = Date.now()) {
  const { start, end } = previousPeriod(type, nowMs);
  const inPeriod = dailyCandles.filter(c => {
    const t = +c.time;
    return t >= start && t + DAY_MS <= end;
  });
  const expected = Math.round((end - start) / DAY_MS);
  if (inPeriod.length < expected) return null;

  const high = Math.max(...inPeriod.map(c => c.high));
  const low = Math.min(...inPeriod.map(c => c.low));
  if (!(high > 0) || !(low > 0) || !(high >= low)) return null;
  const mid = (high + low) / 2;
  const boxHeight = high - low;
  if (!(boxHeight > 0) || !(mid > 0)) return null;

  return {
    type,
    prevHigh: high,
    prevLow: low,
    prevMid: mid,
    boxHeight,
    boxRangePct: (boxHeight / mid) * 100,
    periodKey: new Date(start).toISOString().slice(0, type === 'month' ? 7 : 10),
    periodStart: start,
  };
}

/**
 * LONG na última vela 15m FECHADA (candles15m em ordem ascendente, com
 * { time, close }). Velas ainda em formação (time + 15m > now) são ignoradas.
 */
function detectBreakout(candles15m, levels, params = RUMERS_BOX_DEFAULTS, nowMs = Date.now()) {
  const range = params.boxRangePct?.[levels.type] ?? RUMERS_BOX_DEFAULTS.boxRangePct[levels.type];
  if (levels.boxRangePct < range.min || levels.boxRangePct > range.max) return null;

  const closed = candles15m.filter(c => +c.time + BAR_15M_MS <= nowMs);
  if (closed.length < 2) return null;
  const curr = closed[closed.length - 1];
  const prevBar = closed[closed.length - 2];
  if (!(curr.close > 0) || !(prevBar.close > 0)) return null;

  const { prevHigh, prevLow } = levels;
  const crossed = curr.close > prevHigh && prevBar.close <= prevHigh;
  if (!crossed) return null;
  const requireInside = params.requireInsideBeforeBreak !== false;
  if (requireInside && !(prevBar.close >= prevLow && prevBar.close <= prevHigh)) return null;

  const stopLossPct = Math.max(0.005, Number(params.stopLossPct ?? 0.12));
  const tp1Pct = Math.max(0.01, Number(params.tp1Pct ?? 0.65));
  const entryPrice = curr.close;
  const breakPct = ((curr.close - prevHigh) / prevHigh) * 100;

  return {
    direction: 'BUY',
    entryPrice,
    stopLoss: entryPrice * (1 - stopLossPct),
    target1: entryPrice * (1 + tp1Pct),
    breakPct,
    strength: Math.min(95, Math.max(70, Math.round(72 + Math.min(18, breakPct * 10)))),
    barTime: +curr.time,
    levels,
  };
}

module.exports = {
  RUMERS_BOX_DEFAULTS,
  BOX_TYPES,
  computeBoxLevels,
  detectBreakout,
  previousPeriod,
};
