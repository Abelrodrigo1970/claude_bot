const { Stochastic, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'StochMomentum';

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
  const rsi   = RSI.calculate({ period: 14, values: closes });

  const last  = stoch[stoch.length - 1];
  const prev  = stoch[stoch.length - 2];
  const lastRsi    = rsi[rsi.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const c0 = closes[closes.length - 1];
  const c1 = closes[closes.length - 2];
  const c2 = closes[closes.length - 3];

  const kCrossedAboveD = prev.k <= prev.d && last.k > last.d;
  const kCrossedBelowD = prev.k >= prev.d && last.k < last.d;
  const oversold       = last.k < 20 && last.d < 20;
  const overbought     = last.k > 80 && last.d > 80;
  const volumeOk       = lastVolume > avgVolume * 0.7;
  const candleUp       = c0 > c1 && c0 > c2;
  const candleDown     = c0 < c1 && c0 < c2;

  return {
    k: last.k, d: last.d,
    rsi: lastRsi,
    volRatio: avgVolume > 0 ? lastVolume / avgVolume : 0,
    kCrossedAboveD, kCrossedBelowD,
    oversold, overbought,
    volumeOk, candleUp, candleDown,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 100) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 100)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    // LONG: Stoch oversold + K cruza acima D + volume + vela↑ + RSI não sobrecomprado
    if (ind.oversold && ind.kCrossedAboveD && ind.volumeOk && ind.candleUp && ind.rsi < 55) {
      return {
        signal: 'long',
        reason: `Stoch oversold K=${ind.k?.toFixed(1)} cruza↑D=${ind.d?.toFixed(1)} · RSI=${ind.rsi?.toFixed(1)} · Vol=${ind.volRatio?.toFixed(1)}x · vela↑`,
        indicators: ind,
      };
    }
    // SHORT: Stoch overbought + K cruza abaixo D + volume + vela↓ + RSI não sobrevendido
    if (ind.overbought && ind.kCrossedBelowD && ind.volumeOk && ind.candleDown && ind.rsi > 45) {
      return {
        signal: 'short',
        reason: `Stoch overbought K=${ind.k?.toFixed(1)} cruza↓D=${ind.d?.toFixed(1)} · RSI=${ind.rsi?.toFixed(1)} · Vol=${ind.volRatio?.toFixed(1)}x · vela↓`,
        indicators: ind,
      };
    }
  }

  if (currentPosition === 'long' && ind.overbought && ind.kCrossedBelowD) {
    return { signal: 'flip_to_short', reason: `Stoch overbought + K cruza abaixo D`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.oversold && ind.kCrossedAboveD) {
    return { signal: 'flip_to_long', reason: `Stoch oversold + K cruza acima D`, indicators: ind };
  }

  return {
    signal: 'hold',
    reason: `Hold: K=${ind.k?.toFixed(1)}, D=${ind.d?.toFixed(1)}, RSI=${ind.rsi?.toFixed(1)}, Trend=—`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
