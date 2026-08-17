// Cruzamento de médias EMA12/EMA70 — sempre no mercado, inverte de posição a
// cada cruzamento (sem filtro): EMA12 cruza acima da EMA70 -> LONG (fecha um
// SHORT aberto, se existir); EMA12 cruza abaixo -> SHORT (fecha um LONG
// aberto, se existir).
const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'StockEma1270Cross';
const EMA_FAST = 12;
const EMA_SLOW = 70;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const emaFastArr = EMA.calculate({ period: EMA_FAST, values: closes });
  const emaSlowArr = EMA.calculate({ period: EMA_SLOW, values: closes });

  const f0 = emaFastArr[emaFastArr.length - 1];
  const f1 = emaFastArr[emaFastArr.length - 2];
  const s0 = emaSlowArr[emaSlowArr.length - 1];
  const s1 = emaSlowArr[emaSlowArr.length - 2];
  const hasCross = f0 != null && f1 != null && s0 != null && s1 != null;

  return {
    emaFast: f0,
    emaSlow: s0,
    crossUp: hasCross && f1 <= s1 && f0 > s0,
    crossDown: hasCross && f1 >= s1 && f0 < s0,
    price: closes[closes.length - 1],
  };
}

function generateSignal(candles, currentPosition = null) {
  const minCandles = EMA_SLOW + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition && ind.crossUp) {
    return {
      signal: 'long',
      reason: `EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) cruzou acima de EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)})`,
      indicators: ind,
    };
  }
  if (!currentPosition && ind.crossDown) {
    return {
      signal: 'short',
      reason: `EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) cruzou abaixo de EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)})`,
      indicators: ind,
    };
  }
  if (currentPosition === 'long' && ind.crossDown) {
    return {
      signal: 'flip_to_short',
      reason: `EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) cruzou abaixo de EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)}) — fecha long, abre short`,
      indicators: ind,
    };
  }
  if (currentPosition === 'short' && ind.crossUp) {
    return {
      signal: 'flip_to_long',
      reason: `EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) cruzou acima de EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)}) — fecha short, abre long`,
      indicators: ind,
    };
  }

  return {
    signal: 'hold',
    reason: `Mantém ${currentPosition || 'flat'} — EMA${EMA_FAST}=${ind.emaFast?.toFixed(4)} ${ind.emaFast > ind.emaSlow ? '>' : '<'} EMA${EMA_SLOW}=${ind.emaSlow?.toFixed(4)}`,
    indicators: ind,
  };
}

module.exports = { STRATEGY_NAME, EMA_FAST, EMA_SLOW, generateSignal, calculateIndicators };
