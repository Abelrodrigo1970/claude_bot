const { MACD, EMA } = require('technicalindicators');

const STRATEGY_NAME = 'MACDRider';

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const ema200 = EMA.calculate({ period: 200, values: closes });

  const last = macd[macd.length - 1];
  const prev = macd[macd.length - 2];
  const lastEma200 = ema200[ema200.length - 1];
  const lastClose = closes[closes.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const bullishCross = prev.MACD <= prev.signal && last.MACD > last.signal;
  const bearishCross = prev.MACD >= prev.signal && last.MACD < last.signal;
  const aboveEma200 = lastClose > lastEma200;
  const volumeConfirm = lastVolume > avgVolume * 1.2;

  return {
    macd: last.MACD,
    signal: last.signal,
    histogram: last.histogram,
    ema200: lastEma200,
    bullishCross,
    bearishCross,
    aboveEma200,
    volumeConfirm,
    lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 250) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 250)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.bullishCross && ind.aboveEma200 && ind.histogram > 0) {
      return {
        signal: 'long',
        reason: `MACD cruzou acima do signal acima da EMA200. Hist=${ind.histogram?.toFixed(6)}`,
        indicators: ind,
      };
    }
    if (ind.bearishCross && !ind.aboveEma200 && ind.histogram < 0) {
      return {
        signal: 'short',
        reason: `MACD cruzou abaixo do signal abaixo da EMA200. Hist=${ind.histogram?.toFixed(6)}`,
        indicators: ind,
      };
    }
  }

  if (currentPosition === 'long' && ind.bearishCross) {
    return { signal: 'flip_to_short', reason: `MACD bearish cross — inversão para SHORT`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.bullishCross) {
    return { signal: 'flip_to_long', reason: `MACD bullish cross — inversão para LONG`, indicators: ind };
  }

  return {
    signal: 'hold',
    reason: `Hold: MACD=${ind.macd?.toFixed(6)}, Signal=${ind.signal?.toFixed(6)}, Hist=${ind.histogram?.toFixed(6)}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
