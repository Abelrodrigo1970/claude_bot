const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'PumpTrendFlip';

// Timeframe mais lento (1h) e EMAs mais lentas (21/50) do que a
// PumpEmaSpread (5m, 12/21) — de propósito. Os estudos anteriores mostraram
// que EMAs rápidas em 5m cruzam ~350x/mês em pares de pump (muito ruído
// para "surfar"), e que uma banda superior (spreadOk < 1.5%) trava trades
// grandes como o do BTR. Esta estratégia não tem teto de spread — quer
// mesmo ficar agarrada a tendências esticadas.
const MIN_SPREAD_PCT = 1.0;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const ema21Arr = EMA.calculate({ period: 21, values: closes });
  const ema50Arr = EMA.calculate({ period: 50, values: closes });

  const price = closes[closes.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];

  const diffPct = Math.abs(ema21 - ema50) / ema50 * 100;
  const bullish = ema21 > ema50;
  const bearish = ema21 < ema50;

  // Confirmação mínima — só age quando o afastamento já é claro, para não
  // inverter em ruído de um cruzamento marginal. Sem teto: quanto mais
  // esticado, melhor, é o objetivo desta estratégia.
  const confirmed = diffPct > MIN_SPREAD_PCT;

  return { price, ema21, ema50, diffPct, bullish, bearish, confirmed };
}

// Está sempre no mercado (long ou short, nunca de fora) depois da primeira
// entrada — quando a tendência inverte com confirmação, fecha a posição
// atual e abre logo a oposta (flip_to_long/flip_to_short), sem passar por
// "flat" à espera de nova entrada.
function generateSignal(candles, currentPosition = null) {
  if (candles.length < 55) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 55)', indicators: {} };
  }

  const ind = calculateIndicators(candles);
  const base = `EMA21=${ind.ema21.toFixed(6)} ${ind.bullish ? '>' : '<'} EMA50=${ind.ema50.toFixed(6)} · spread=${ind.diffPct.toFixed(2)}%`;

  if (!currentPosition) {
    if (ind.bullish && ind.confirmed) {
      return { signal: 'long', reason: `${base} · confirmado (>${MIN_SPREAD_PCT}%) — entra long`, indicators: ind };
    }
    if (ind.bearish && ind.confirmed) {
      return { signal: 'short', reason: `${base} · confirmado (>${MIN_SPREAD_PCT}%) — entra short`, indicators: ind };
    }
    return { signal: 'hold', reason: `${base} · sem confirmação ainda`, indicators: ind };
  }

  if (currentPosition === 'long' && ind.bearish && ind.confirmed) {
    return { signal: 'flip_to_short', reason: `${base} · tendência inverteu — vira short`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.bullish && ind.confirmed) {
    return { signal: 'flip_to_long', reason: `${base} · tendência inverteu — vira long`, indicators: ind };
  }

  return { signal: 'hold', reason: `${base} · mantém ${currentPosition}`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
