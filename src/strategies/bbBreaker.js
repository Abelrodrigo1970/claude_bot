const { BollingerBands, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'BBBreaker';

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const rsi = RSI.calculate({ period: 14, values: closes });

  const last = bb[bb.length - 1];
  const prev = bb[bb.length - 2];
  const lastClose  = closes[closes.length - 1];
  const prevClose  = closes[closes.length - 2];
  const prev2Close = closes[closes.length - 3];
  const lastRsi    = rsi[rsi.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const bandwidth     = (last.upper - last.lower) / last.middle;
  const prevBandwidth = (prev.upper - prev.lower) / prev.middle;
  const squeeze       = prevBandwidth < 0.08 && bandwidth > prevBandwidth;

  const breakoutUp   = prevClose <= prev.upper && lastClose > last.upper;
  const breakoutDown = prevClose >= prev.lower && lastClose < last.lower;
  const volumeConfirm = lastVolume > avgVolume * 0.7;

  // Confirmação de vela: fecha acima/abaixo das 2 anteriores
  const candleUp   = lastClose > prevClose && lastClose > prev2Close;
  const candleDown = lastClose < prevClose && lastClose < prev2Close;

  return {
    upper: last.upper,
    middle: last.middle,
    lower: last.lower,
    bandwidth,
    rsi: lastRsi,
    squeeze,
    breakoutUp,
    breakoutDown,
    volumeConfirm,
    candleUp,
    candleDown,
    lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 100) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 100)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.breakoutUp && ind.volumeConfirm && ind.candleUp && ind.rsi < 75) {
      return {
        signal: 'long',
        reason: `Breakout BB superior · RSI=${ind.rsi?.toFixed(1)} · Vol=${(ind.volumeConfirm ? '✓' : '✗')} · vela↑`,
        indicators: ind,
      };
    }
    if (ind.breakoutDown && ind.volumeConfirm && ind.candleDown && ind.rsi > 25) {
      return {
        signal: 'short',
        reason: `Breakout BB inferior · RSI=${ind.rsi?.toFixed(1)} · Vol=${(ind.volumeConfirm ? '✓' : '✗')} · vela↓`,
        indicators: ind,
      };
    }
  }

  if (currentPosition === 'long' && ind.lastClose < ind.middle) {
    return { signal: 'flip_to_short', reason: `Preço regressou à linha central BB — inversão SHORT`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.lastClose > ind.middle) {
    return { signal: 'flip_to_long', reason: `Preço regressou à linha central BB — inversão LONG`, indicators: ind };
  }

  return {
    signal: 'hold',
    reason: `Hold: BW=${(ind.bandwidth * 100)?.toFixed(2)}%, Upper=${ind.upper?.toFixed(4)}, RSI=${ind.rsi?.toFixed(1)}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
