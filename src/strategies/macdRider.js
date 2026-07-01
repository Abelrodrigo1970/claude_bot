const { MACD, EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'MACDRider';

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const ema200Arr = EMA.calculate({ period: 200, values: closes });
  const ema50Arr  = EMA.calculate({ period: 50,  values: closes });
  const rsiArr    = RSI.calculate({ period: 14,  values: closes });

  const last     = macd[macd.length - 1];
  const prev     = macd[macd.length - 2];
  const ema200   = ema200Arr[ema200Arr.length - 1];
  const ema50    = ema50Arr[ema50Arr.length - 1];
  const rsi      = rsiArr[rsiArr.length - 1];
  const lastClose  = closes[closes.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;

  const bullishCross  = prev.MACD <= prev.signal && last.MACD > last.signal;
  const bearishCross  = prev.MACD >= prev.signal && last.MACD < last.signal;

  // LONG: cruzamento bullish + MACD acima de zero + preço > EMA200 > EMA50 + RSI 35-68 + volume
  const macdAboveZero = last.MACD > 0;
  const macdBelowZero = last.MACD < 0;
  const aboveEma200   = lastClose > ema200;
  const aboveEma50    = lastClose > ema50;
  const volumeOk      = volRatio >= 1.2;
  const rsiLong       = rsi >= 35 && rsi <= 68;
  const rsiShort      = rsi >= 32 && rsi <= 65;

  const validLong  = bullishCross && aboveEma200 && aboveEma50 && macdAboveZero && last.histogram > 0 && volumeOk && rsiLong;
  const validShort = bearishCross && !aboveEma200 && macdBelowZero && last.histogram < 0 && volumeOk && rsiShort;

  return {
    macd: last.MACD,
    signal: last.signal,
    histogram: last.histogram,
    ema200,
    ema50,
    rsi,
    volRatio,
    bullishCross,
    bearishCross,
    aboveEma200,
    aboveEma50,
    macdAboveZero,
    macdBelowZero,
    volumeOk,
    rsiLong,
    rsiShort,
    validLong,
    validShort,
    lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 250) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 250)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saída de LONG: cruzamento bearish
  if (currentPosition === 'long' && ind.bearishCross) {
    return {
      signal: 'close_long',
      reason: `MACD bearish cross — fecha LONG. MACD=${ind.macd?.toFixed(5)} RSI=${ind.rsi?.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Saída de SHORT: cruzamento bullish
  if (currentPosition === 'short' && ind.bullishCross) {
    return {
      signal: 'close_short',
      reason: `MACD bullish cross — fecha SHORT. MACD=${ind.macd?.toFixed(5)} RSI=${ind.rsi?.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Entrada LONG
  if (!currentPosition && ind.validLong) {
    return {
      signal: 'long',
      reason: `MACD↑ acima zero · EMA200=${ind.ema200?.toFixed(4)} · EMA50=${ind.ema50?.toFixed(4)} · RSI=${ind.rsi?.toFixed(1)} · Vol=${ind.volRatio?.toFixed(1)}x`,
      indicators: ind,
    };
  }

  // Entrada SHORT
  if (!currentPosition && ind.validShort) {
    return {
      signal: 'short',
      reason: `MACD↓ abaixo zero · EMA200=${ind.ema200?.toFixed(4)} · RSI=${ind.rsi?.toFixed(1)} · Vol=${ind.volRatio?.toFixed(1)}x`,
      indicators: ind,
    };
  }

  // Hold — diagnóstico
  const missing = [];
  if (!currentPosition) {
    if (ind.bullishCross || ind.bearishCross) {
      const dir = ind.bullishCross ? 'LONG' : 'SHORT';
      if (ind.bullishCross) {
        if (!ind.aboveEma200)   missing.push(`preço abaixo EMA200`);
        if (!ind.aboveEma50)    missing.push(`preço abaixo EMA50`);
        if (!ind.macdAboveZero) missing.push(`MACD<0(${ind.macd?.toFixed(5)})`);
        if (!ind.volumeOk)      missing.push(`Vol=${ind.volRatio?.toFixed(1)}x<1.2`);
        if (!ind.rsiLong)       missing.push(`RSI=${ind.rsi?.toFixed(1)} fora 35-68`);
      } else {
        if (ind.aboveEma200)    missing.push(`preço acima EMA200`);
        if (!ind.macdBelowZero) missing.push(`MACD>0(${ind.macd?.toFixed(5)})`);
        if (!ind.volumeOk)      missing.push(`Vol=${ind.volRatio?.toFixed(1)}x<1.2`);
        if (!ind.rsiShort)      missing.push(`RSI=${ind.rsi?.toFixed(1)} fora 32-65`);
      }
      return {
        signal: 'hold',
        reason: `Cross ${dir} mas falta: ${missing.join(' · ')}`,
        indicators: ind,
      };
    }
  }

  return {
    signal: 'hold',
    reason: `Hold: MACD=${ind.macd?.toFixed(5)} · Signal=${ind.signal?.toFixed(5)} · RSI=${ind.rsi?.toFixed(1)}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
