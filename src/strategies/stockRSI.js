const { RSI, EMA } = require('technicalindicators');

const STRATEGY_NAME = 'StockRSI';
const MIN_GAP    = 3;    // pontos mínimos entre RSI e signal line após cruzamento
const MIN_VOL    = 0.5;  // volume mínimo vs média (filtro de liquidez)
const RSI_SHORT_MIN = 60; // RSI mínimo para entrar SHORT (sobrecompra real)
const RSI_LONG_MAX  = 45; // RSI máximo para entrar LONG (sobrevenda real)

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsiArr    = RSI.calculate({ period: 14, values: closes });
  const rsiSignal = EMA.calculate({ period: 9,  values: rsiArr });

  const lastRsi  = rsiArr[rsiArr.length - 1];
  const prevRsi  = rsiArr[rsiArr.length - 2];
  const lastSig  = rsiSignal[rsiSignal.length - 1];
  const prevSig  = rsiSignal[rsiSignal.length - 2];

  const gap = lastRsi - lastSig; // positivo = RSI acima signal

  const crossedUp   = prevRsi <= prevSig && lastRsi > lastSig;
  const crossedDown = prevRsi >= prevSig && lastRsi < lastSig;

  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;
  const volumeOk   = volRatio >= MIN_VOL;

  // LONG: cruzamento para cima com gap >= 3 + RSI não sobrecomprado + volume ok
  const validLong  = crossedUp   && gap >= MIN_GAP  && lastRsi <= RSI_LONG_MAX  && volumeOk;
  // SHORT: cruzamento para baixo com gap >= 3 + RSI acima de 60 (reversão real) + volume ok
  const validShort = crossedDown && Math.abs(gap) >= MIN_GAP && lastRsi >= RSI_SHORT_MIN && volumeOk;

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

  // Saídas — sem filtro de volume (sempre fecha quando cruza)
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

  // Entrada LONG
  if (!currentPosition && ind.validLong) {
    return {
      signal: 'long',
      reason: `RSI(${ind.rsi.toFixed(1)}) cruzou↑ Signal(${ind.rsiSignal.toFixed(1)}) · gap=+${ind.gap.toFixed(1)}pts · Vol=${ind.volRatio.toFixed(2)}x`,
      indicators: ind,
    };
  }

  // Entrada SHORT
  if (!currentPosition && ind.validShort) {
    return {
      signal: 'short',
      reason: `RSI(${ind.rsi.toFixed(1)}) cruzou↓ Signal(${ind.rsiSignal.toFixed(1)}) · gap=${ind.gap.toFixed(1)}pts · Vol=${ind.volRatio.toFixed(2)}x`,
      indicators: ind,
    };
  }

  // Hold — diagnóstico
  const missing = [];
  if (ind.crossedUp || ind.crossedDown) {
    if (ind.crossedUp) {
      if (Math.abs(ind.gap) < MIN_GAP)         missing.push(`gap=+${ind.gap.toFixed(1)}<${MIN_GAP}`);
      if (ind.rsi > RSI_LONG_MAX)              missing.push(`RSI=${ind.rsi.toFixed(1)}>${RSI_LONG_MAX} (não oversold)`);
      if (!ind.volumeOk)                       missing.push(`Vol=${ind.volRatio.toFixed(2)}x<${MIN_VOL}`);
    } else {
      if (Math.abs(ind.gap) < MIN_GAP)         missing.push(`gap=${ind.gap.toFixed(1)} abs<${MIN_GAP}`);
      if (ind.rsi < RSI_SHORT_MIN)             missing.push(`RSI=${ind.rsi.toFixed(1)}<${RSI_SHORT_MIN} (não overbought)`);
      if (!ind.volumeOk)                       missing.push(`Vol=${ind.volRatio.toFixed(2)}x<${MIN_VOL}`);
    }
    const dir = ind.crossedUp ? 'LONG↑' : 'SHORT↓';
    return {
      signal: 'hold',
      reason: `Cross ${dir} mas falta: ${missing.join(' · ')}`,
      indicators: ind,
    };
  }

  const dir = ind.gap >= 0
    ? `RSI acima signal +${ind.gap.toFixed(1)}pts`
    : `RSI abaixo signal ${ind.gap.toFixed(1)}pts`;

  return {
    signal: 'hold',
    reason: `Hold: ${dir} · sem cruzamento`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
