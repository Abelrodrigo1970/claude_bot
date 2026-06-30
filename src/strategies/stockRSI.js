const { RSI, EMA } = require('technicalindicators');

const STRATEGY_NAME = 'StockRSI';
const MIN_GAP = 3; // pontos mínimos entre RSI e signal line após cruzamento

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsiArr    = RSI.calculate({ period: 14, values: closes });
  const rsiSignal = EMA.calculate({ period: 9, values: rsiArr });

  const lastRsi  = rsiArr[rsiArr.length - 1];
  const prevRsi  = rsiArr[rsiArr.length - 2];
  const lastSig  = rsiSignal[rsiSignal.length - 1];
  const prevSig  = rsiSignal[rsiSignal.length - 2];

  const gap = lastRsi - lastSig; // positivo = RSI acima signal

  const crossedUp   = prevRsi <= prevSig && lastRsi > lastSig;
  const crossedDown = prevRsi >= prevSig && lastRsi < lastSig;

  const validLong  = crossedUp   && gap >= MIN_GAP;
  const validShort = crossedDown && Math.abs(gap) >= MIN_GAP;

  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;

  return {
    rsi: lastRsi,
    rsiSignal: lastSig,
    gap,
    crossedUp,
    crossedDown,
    validLong,
    validShort,
    volRatio,
    price: closes[closes.length - 1],
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 30) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 30)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saídas de posição aberta
  if (currentPosition === 'long' && ind.crossedDown) {
    return {
      signal: 'close_long',
      reason: `RSI(${ind.rsi.toFixed(1)}) cruzou↓ Signal(${ind.rsiSignal.toFixed(1)})`,
      indicators: ind,
    };
  }
  if (currentPosition === 'short' && ind.crossedUp) {
    return {
      signal: 'close_short',
      reason: `RSI(${ind.rsi.toFixed(1)}) cruzou↑ Signal(${ind.rsiSignal.toFixed(1)})`,
      indicators: ind,
    };
  }

  // Entradas sem posição aberta
  if (!currentPosition) {
    if (ind.validLong) {
      return {
        signal: 'long',
        reason: `RSI(${ind.rsi.toFixed(1)}) cruzou↑ Signal(${ind.rsiSignal.toFixed(1)}) · gap=+${ind.gap.toFixed(1)}pts`,
        indicators: ind,
      };
    }
    if (ind.validShort) {
      return {
        signal: 'short',
        reason: `RSI(${ind.rsi.toFixed(1)}) cruzou↓ Signal(${ind.rsiSignal.toFixed(1)}) · gap=${ind.gap.toFixed(1)}pts`,
        indicators: ind,
      };
    }
  }

  // Hold
  const dir = ind.gap >= 0
    ? `RSI acima signal +${ind.gap.toFixed(1)}pts`
    : `RSI abaixo signal ${ind.gap.toFixed(1)}pts`;
  const needsCross = !ind.crossedUp && !ind.crossedDown ? ' · sem cruzamento' : '';
  const needsGap   = Math.abs(ind.gap) < MIN_GAP ? ` · gap<${MIN_GAP}pts` : '';

  return {
    signal: 'hold',
    reason: `Hold: ${dir}${needsCross}${needsGap}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
