const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'CLOEmaFlip';
const EMA_FAST = 12;
const EMA_SLOW = 80;
const THRESHOLD_PCT = 0.5; // % de distância entre as EMAs para disparar entrada/inversão

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const emaFastArr = EMA.calculate({ period: EMA_FAST, values: closes });
  const emaSlowArr = EMA.calculate({ period: EMA_SLOW, values: closes });

  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const spreadPct = ((emaFast - emaSlow) / emaSlow) * 100;

  return {
    emaFast,
    emaSlow,
    spreadPct,
    bullish: spreadPct >= THRESHOLD_PCT,
    bearish: spreadPct <= -THRESHOLD_PCT,
    price: closes[closes.length - 1],
  };
}

// Sempre posicionada: LONG quando EMA12 está >=THRESHOLD_PCT acima da EMA80,
// SHORT quando está >=THRESHOLD_PCT abaixo. Dentro da zona neutra não abre
// nem fecha, só mantém o que já estiver aberto até o spread decidir um lado.
function generateSignal(candles, currentPosition = null) {
  if (candles.length < EMA_SLOW + 5) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${EMA_SLOW + 5})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.bullish) {
      return {
        signal: 'long',
        reason: `EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) ${ind.spreadPct.toFixed(2)}% acima da EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)})`,
        indicators: ind,
      };
    }
    if (ind.bearish) {
      return {
        signal: 'short',
        reason: `EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) ${ind.spreadPct.toFixed(2)}% abaixo da EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)})`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: `Spread=${ind.spreadPct.toFixed(2)}% dentro da zona neutra (±${THRESHOLD_PCT}%)`, indicators: ind };
  }

  if (currentPosition === 'long' && ind.bearish) {
    return {
      signal: 'flip_to_short',
      reason: `Spread inverteu para ${ind.spreadPct.toFixed(2)}% — fecha long, abre short`,
      indicators: ind,
    };
  }
  if (currentPosition === 'short' && ind.bullish) {
    return {
      signal: 'flip_to_long',
      reason: `Spread inverteu para ${ind.spreadPct.toFixed(2)}% — fecha short, abre long`,
      indicators: ind,
    };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — spread=${ind.spreadPct.toFixed(2)}%`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
