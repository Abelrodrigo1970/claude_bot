// ElliotV8 ichiv2 (5m) — port da ElliotV8_original_ichiv2 da coleção
// freqtrade davidzr/freqtrade-strategies (@Rallipanos, alterações IcHiAT).
// Universo neste app: scanner EMA200 (top 50 por % acima da EMA200 diária,
// entre os 250 perpétuos USDT com mais volume) — scannerPeriod 200.
//
// Indicadores (velas 5m FECHADAS), iguais aos do talib/qtpylib do original:
//   ma_buy  = EMA12 · ma_sell = EMA22 (EMA do talib: semente = média simples)
//   EWO     = (EMA50 − EMA200) / close × 100
//   RSI14 / RSI4 / RSI20 (Wilder, como o talib)
//   hma_50  = "Hull" do qtpylib, que na verdade usa médias exponenciais
//             ajustadas (pandas ewm adjust=True, min_periods=50):
//             ewm(2·ewm(close, 25) − ewm(close, 50), √50)
//
// Entrada LONG (qualquer uma):
//   RSI4 < 35 · close < EMA12 × 0,987 · EWO > 3,147 · RSI14 < 57 · close < EMA22 × 1,008
//   RSI4 < 35 · close < EMA12 × 0,987 · EWO < −17,145 · close < EMA22 × 1,008
//
// Saída por sinal (close_long), só com lucro > 1% já descontadas as taxas
// (sell_profit_only + sell_profit_offset 0,01 do original):
//   close > hma_50 · close > EMA22 × 1,016 · RSI14 > 50 · RSI4 > RSI20
//   OU close < hma_50 · close > EMA22 × 1,008 · RSI4 > RSI20
//
// Gestão (runner, candleStops): SL 4% (o original usa 20%) · trailing do
// freqtrade: depois de o máximo desde a entrada passar +2%, o stop sobe para
// 0,1% abaixo desse máximo. Verificado vela a vela com máximos/mínimos 5m.
//
// Estudo (strategy-lab-bot/ft_vol30.py, universo EMA200 top 50 reconstruído
// dia a dia, $100/trade, taxas 0,055%/lado), SL 4%:
//   2025: 1996 trades, WR 70%, PF 1,52, +1285, DD 70
//   2026 (jan–out): 4898 trades, WR 66%, PF 1,41, +2775, DD 152
// (SL 6–8% dá PF ~1,6/1,47 com mais drawdown; o utilizador escolheu 4%, 12/10)

const STRATEGY_NAME = 'ElliotV8Ichiv2';
const TF_MS = 5 * 60 * 1000;
const FEE = 0.00055;

const BASE_BUY = 12;
const BASE_SELL = 22;
const LOW_OFFSET = 0.987;
const HIGH_OFFSET = 1.008;
const HIGH_OFFSET_2 = 1.016;
const EWO_FAST = 50;
const EWO_SLOW = 200;
const EWO_LOW = -17.145;
const EWO_HIGH = 3.147;
const RSI_BUY = 57;
const SELL_PROFIT_OFFSET = 0.01;

const STOP_LOSS_PCT = 0.04;
const TRAIL_OFFSET_PCT = 0.02;
const TRAIL_POSITIVE_PCT = 0.001;

// EMA como o talib: começa na média simples das primeiras n velas.
function emaTalib(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  let e = sum / n;
  out[n - 1] = e;
  const a = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    e = a * values[i] + (1 - a) * e;
    out[i] = e;
  }
  return out;
}

// RSI como o talib (Wilder, semente = média das primeiras n variações).
function rsiTalib(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= n;
  l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// pandas ewm(span, adjust=True, min_periods) — ignora nulls iniciais.
function ewmAdjusted(values, span, minPeriods) {
  const out = new Array(values.length).fill(null);
  const a = 2 / (span + 1);
  let num = 0;
  let den = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    num = v + (1 - a) * num;
    den = 1 + (1 - a) * den;
    count++;
    if (count >= minPeriods) out[i] = num / den;
  }
  return out;
}

// hull_moving_average do qtpylib (window 50).
function hmaQtpylib(values, window) {
  const half = ewmAdjusted(values, window / 2, window);
  const full = ewmAdjusted(values, window, window);
  const diff = values.map((_, i) => (half[i] == null || full[i] == null ? null : 2 * half[i] - full[i]));
  return ewmAdjusted(diff, Math.sqrt(window), window);
}

function calculateIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  if (n < EWO_SLOW + 100) return { ok: false, reason: `velas fechadas insuficientes (${n})` };
  const i = n - 1;
  const maBuy = emaTalib(closes, BASE_BUY)[i];
  const maSell = emaTalib(closes, BASE_SELL)[i];
  const ema50 = emaTalib(closes, EWO_FAST)[i];
  const ema200 = emaTalib(closes, EWO_SLOW)[i];
  const rsi = rsiTalib(closes, 14)[i];
  const rsiFast = rsiTalib(closes, 4)[i];
  const rsiSlow = rsiTalib(closes, 20)[i];
  const hma50 = hmaQtpylib(closes, 50)[i];
  const close = closes[i];
  if ([maBuy, maSell, ema50, ema200, rsi, rsiFast, rsiSlow, hma50].some((v) => v == null)) {
    return { ok: false, reason: 'indicadores indisponíveis' };
  }
  return {
    ok: true,
    close,
    volume: candles[i].volume,
    maBuy, maSell, rsi, rsiFast, rsiSlow, hma50,
    ewo: ((ema50 - ema200) / close) * 100,
  };
}

function entrySignal(ind) {
  const common = ind.rsiFast < 35 && ind.close < ind.maBuy * LOW_OFFSET &&
    ind.volume > 0 && ind.close < ind.maSell * HIGH_OFFSET;
  const a = common && ind.ewo > EWO_HIGH && ind.rsi < RSI_BUY;
  const b = common && ind.ewo < EWO_LOW;
  return a || b;
}

function exitSignal(ind) {
  const a = ind.close > ind.hma50 && ind.close > ind.maSell * HIGH_OFFSET_2 &&
    ind.rsi > 50 && ind.volume > 0 && ind.rsiFast > ind.rsiSlow;
  const b = ind.close < ind.hma50 && ind.close > ind.maSell * HIGH_OFFSET &&
    ind.volume > 0 && ind.rsiFast > ind.rsiSlow;
  return a || b;
}

function closedOnly(candles, now = Date.now()) {
  return candles.filter((c) => new Date(c.time).getTime() + TF_MS <= now);
}

function generateSignal(candles, currentPosition, context = {}) {
  const closed = closedOnly(candles);
  const ind = calculateIndicators(closed);
  if (!ind.ok) return { signal: 'none', reason: ind.reason, indicators: {} };

  const indicators = {
    close: ind.close,
    ewo: +ind.ewo.toFixed(3),
    rsi: +ind.rsi.toFixed(1),
    rsiFast: +ind.rsiFast.toFixed(1),
    rsiSlow: +ind.rsiSlow.toFixed(1),
    maBuy: ind.maBuy,
    maSell: ind.maSell,
    hma50: ind.hma50,
  };

  if (currentPosition === 'long') {
    if (!exitSignal(ind)) return { signal: 'hold', reason: 'em posição · sem sinal de saída', indicators };
    // sell_profit_only: lucro no fecho da vela de sinal, já com as duas taxas
    const entry = context.entryPrice;
    const profit = entry ? ind.close / entry - 1 - 2 * FEE : null;
    if (profit == null || profit <= SELL_PROFIT_OFFSET) {
      return { signal: 'hold', reason: `sinal de saída ignorado (lucro ${profit == null ? '?' : (profit * 100).toFixed(2)}% ≤ 1%)`, indicators };
    }
    return { signal: 'close_long', reason: `sinal de saída com lucro ${(profit * 100).toFixed(2)}%`, indicators };
  }
  if (currentPosition) return { signal: 'hold', reason: `posição ${currentPosition} não gerida`, indicators };

  if (entrySignal(ind)) {
    const which = ind.ewo > EWO_HIGH ? `EWO ${ind.ewo.toFixed(2)} > ${EWO_HIGH}` : `EWO ${ind.ewo.toFixed(2)} < ${EWO_LOW}`;
    return {
      signal: 'long',
      reason: `RSI4 ${ind.rsiFast.toFixed(1)} < 35 · close ${((ind.close / ind.maBuy - 1) * 100).toFixed(2)}% vs EMA12 · ${which}`,
      indicators,
    };
  }
  return { signal: 'none', reason: `sem entrada (RSI4 ${ind.rsiFast.toFixed(1)} · EWO ${ind.ewo.toFixed(2)})`, indicators };
}

// Sinais vela a vela de uma série inteira — só para validar contra o Python.
function seriesSignals(candles) {
  const out = [];
  const closes = candles.map((c) => c.close);
  const maBuy = emaTalib(closes, BASE_BUY);
  const maSell = emaTalib(closes, BASE_SELL);
  const e50 = emaTalib(closes, EWO_FAST);
  const e200 = emaTalib(closes, EWO_SLOW);
  const r14 = rsiTalib(closes, 14);
  const r4 = rsiTalib(closes, 4);
  const r20 = rsiTalib(closes, 20);
  const hma = hmaQtpylib(closes, 50);
  for (let i = 0; i < closes.length; i++) {
    const vals = [maBuy[i], maSell[i], e50[i], e200[i], r14[i], r4[i], r20[i], hma[i]];
    if (vals.some((v) => v == null)) { out.push([false, false]); continue; }
    const ind = {
      close: closes[i], volume: candles[i].volume, maBuy: maBuy[i], maSell: maSell[i],
      rsi: r14[i], rsiFast: r4[i], rsiSlow: r20[i], hma50: hma[i],
      ewo: ((e50[i] - e200[i]) / closes[i]) * 100,
    };
    out.push([entrySignal(ind), exitSignal(ind)]);
  }
  return out;
}

module.exports = {
  STRATEGY_NAME,
  STOP_LOSS_PCT,
  TRAIL_OFFSET_PCT,
  TRAIL_POSITIVE_PCT,
  generateSignal,
  seriesSignals,
  calculateIndicators,
};
