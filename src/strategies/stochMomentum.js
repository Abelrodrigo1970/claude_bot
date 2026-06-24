const { Stochastic, EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'StochMomentum';

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const rsi   = RSI.calculate({ period: 14, values: closes });

  const last = stoch[stoch.length - 1];
  const prev = stoch[stoch.length - 2];
  const lastClose  = closes[closes.length - 1];
  const lastEma21  = ema21[ema21.length - 1];
  const lastEma50  = ema50[ema50.length - 1];
  const lastRsi    = rsi[rsi.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const kCrossedAboveD = prev.k <= prev.d && last.k > last.d;
  const kCrossedBelowD = prev.k >= prev.d && last.k < last.d;
  const oversold   = last.k < 20 && last.d < 20;
  const overbought = last.k > 80 && last.d > 80;
  const trendUp    = lastEma21 > lastEma50 && lastClose > lastEma21;
  const trendDown  = lastEma21 < lastEma50 && lastClose < lastEma21;
  const volumeConfirm = lastVolume > avgVolume * 1.1;

  return {
    k: last.k, d: last.d,
    ema21: lastEma21, ema50: lastEma50,
    rsi: lastRsi,
    kCrossedAboveD, kCrossedBelowD,
    oversold, overbought,
    trendUp, trendDown,
    volumeConfirm, lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 100) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 100)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.oversold && ind.kCrossedAboveD && ind.trendUp) {
      return {
        signal: 'long',
        reason: `Stoch oversold (K=${ind.k?.toFixed(1)}) + crossover bullish em tendência de alta`,
        indicators: ind,
      };
    }
    if (ind.overbought && ind.kCrossedBelowD && ind.trendDown) {
      return {
        signal: 'short',
        reason: `Stoch overbought (K=${ind.k?.toFixed(1)}) + crossover bearish em tendência de baixa`,
        indicators: ind,
      };
    }
  }

  if (currentPosition === 'long' && ind.overbought && ind.kCrossedBelowD) {
    return { signal: 'flip_to_short', reason: `Stoch overbought + crossover descendente`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.oversold && ind.kCrossedAboveD) {
    return { signal: 'flip_to_long', reason: `Stoch oversold + crossover ascendente`, indicators: ind };
  }

  return {
    signal: 'hold',
    reason: `Hold: K=${ind.k?.toFixed(1)}, D=${ind.d?.toFixed(1)}, RSI=${ind.rsi?.toFixed(1)}, Trend=${ind.trendUp ? '↑' : ind.trendDown ? '↓' : '—'}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
