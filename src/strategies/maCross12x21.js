// MA Cross 12×21 (15m) — port da MA_CROSS_12X21_S2 do Bot Scanner.
// Universo neste app: Top Ganhos do Mês (scanner periodGainers resultsMonth).
//
// Entrada LONG (última vela 15m FECHADA):
//   EMA12 > EMA21 e spread |12−21|/21 ∈ (0,6% … 1,5%)
//   + novidade (repeat): prev ≤0,6% OU prev não bullish OU alargou ≥0,06 pts
//   + |close−EMA21|/EMA21 ∈ [2% … 4%]
//   + momentum 1h (4×15m) > 0%
//   + hora PT ∈ [11 … 22] (bloqueia 4–10h)
//   + turnover ~3h ≥ $3M
//
// Gestão (runner): SL 15% · TP 60% @ +44% · resto: close_long se spread < 0,5%
const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'MaCross12x21';

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
/** Top N da lista Top Ganhos do Mês. */
const SCANNER_TOP_N = 50;

function hourInLisbon(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  let h = Number(parts.find((p) => p.type === 'hour')?.value);
  if (h === 24) h = 0;
  return h;
}

function isHourBlocked(now = new Date()) {
  const h = hourInLisbon(now);
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

function calculateIndicators(closedCandles) {
  const closes = closedCandles.map((c) => c.close);
  const n = closes.length;
  if (n < SLOW + MOMENTUM_BARS + 5) {
    return { ok: false, reason: `candles fechadas insuficientes (${n})` };
  }

  const price = closes[n - 1];
  const ema12 = lastEma(closes, FAST);
  const ema21 = lastEma(closes, SLOW);
  const prevEma12 = lastEmaAt(closes, FAST, n - 2);
  const prevEma21 = lastEmaAt(closes, SLOW, n - 2);
  if (ema12 == null || ema21 == null || prevEma12 == null || prevEma21 == null || !(ema21 > 0)) {
    return { ok: false, reason: 'EMA indisponível' };
  }

  const diffPct = (Math.abs(ema12 - ema21) / ema21) * 100;
  const prevDiffPct = (Math.abs(prevEma12 - prevEma21) / prevEma21) * 100;
  const bullishNow = ema12 > ema21;
  const bullishPrev = prevEma12 > prevEma21;
  const distSlowPct = (Math.abs(price - ema21) / ema21) * 100;

  const ref = closes[n - 1 - MOMENTUM_BARS];
  const momentum1hPct = ref > 0 ? ((price - ref) / ref) * 100 : null;

  let turnover3h = 0;
  for (let i = Math.max(0, n - 12); i < n; i++) {
    turnover3h += closedCandles[i].volume * closedCandles[i].close;
  }

  const spreadInBand = diffPct > ENTRY_DIFF_MIN && diffPct < ENTRY_DIFF_MAX;
  const repeatOk =
    prevDiffPct <= ENTRY_DIFF_MIN ||
    !bullishPrev ||
    diffPct > prevDiffPct + REPEAT_DELTA;
  const distOk = distSlowPct >= MIN_DIST_SLOW && distSlowPct <= MAX_DIST_SLOW;
  const momOk = momentum1hPct != null && momentum1hPct > MIN_MOMENTUM_1H;
  const turnoverOk = turnover3h >= MIN_TURNOVER_3H;
  const hourOk = !isHourBlocked();

  return {
    ok: true,
    price,
    ema12,
    ema21,
    diffPct,
    prevDiffPct,
    bullishNow,
    distSlowPct,
    momentum1hPct,
    turnover3h,
    hourPt: hourInLisbon(),
    spreadInBand,
    repeatOk,
    distOk,
    momOk,
    turnoverOk,
    hourOk,
    validEntry:
      bullishNow && spreadInBand && repeatOk && distOk && momOk && turnoverOk && hourOk,
  };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  const minRaw = SLOW + MOMENTUM_BARS + 8;
  if (!candles || candles.length < minRaw) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minRaw})`, indicators: {} };
  }

  const closed = candles.slice(0, -1); // exclui vela em formação
  const ind = calculateIndicators(closed);
  if (!ind.ok) {
    return { signal: 'none', reason: ind.reason, indicators: {} };
  }

  const rank = context.rank ?? null;
  const rankOk = !('rank' in context) || (rank != null && rank <= SCANNER_TOP_N);
  ind.rank = rank;
  ind.rankOk = rankOk;

  if (currentPosition === 'long') {
    if (ind.diffPct < EXIT_DIFF) {
      return {
        signal: 'close_long',
        reason: `Spread EMA12/21 ${ind.diffPct.toFixed(2)}% < ${EXIT_DIFF}% — fecha resto`,
        indicators: ind,
      };
    }
    return {
      signal: 'hold',
      reason: `Mantém long — spread ${ind.diffPct.toFixed(2)}% · SL15% / TP60%@+44% / resto por compressão`,
      indicators: ind,
    };
  }

  if (ind.validEntry && rankOk) {
    return {
      signal: 'long',
      reason:
        `EMA12/21 spread ${ind.diffPct.toFixed(2)}% · dist MA21 ${ind.distSlowPct.toFixed(1)}% · ` +
        `mom1h ${ind.momentum1hPct.toFixed(2)}% · ${ind.hourPt}h PT` +
        (rank != null ? ` · rank#${rank} mês` : ''),
      indicators: ind,
    };
  }

  const parts = [];
  if (!ind.bullishNow) parts.push('EMA12≤EMA21');
  else if (!ind.spreadInBand) parts.push(`spread ${ind.diffPct.toFixed(2)}% fora 0,6–1,5%`);
  if (!ind.repeatOk) parts.push('sem novidade de spread');
  if (!ind.distOk) parts.push(`dist MA21 ${ind.distSlowPct.toFixed(1)}% fora 2–4%`);
  if (!ind.momOk) parts.push(`mom1h ${ind.momentum1hPct?.toFixed(2)}%≤0`);
  if (!ind.turnoverOk) parts.push(`turnover3h $${(ind.turnover3h / 1e6).toFixed(1)}M<3M`);
  if (!ind.hourOk) parts.push(`hora ${ind.hourPt}h PT bloqueada`);
  if (!rankOk) parts.push(rank == null ? 'fora do Top Ganhos Mês' : `rank#${rank}>${SCANNER_TOP_N}`);

  return { signal: 'hold', reason: parts.join(' · ') || 'sem entrada', indicators: ind };
}

module.exports = {
  STRATEGY_NAME,
  SCANNER_TOP_N,
  generateSignal,
  calculateIndicators,
  isHourBlocked,
  hourInLisbon,
};
