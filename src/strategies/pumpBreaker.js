const { EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'PumpBreaker';

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema200   = EMA.calculate({ period: 200, values: closes });
  const rsiArr   = RSI.calculate({ period: 14, values: closes });
  const rsiSignal = EMA.calculate({ period: 9, values: rsiArr }); // signal line do RSI

  const lastEma200  = ema200[ema200.length - 1];
  const lastClose   = closes[closes.length - 1];

  const lastRsi     = rsiArr[rsiArr.length - 1];
  const prevRsi     = rsiArr[rsiArr.length - 2];
  const lastSig     = rsiSignal[rsiSignal.length - 1];
  const prevSig     = rsiSignal[rsiSignal.length - 2];

  const lastVolume  = volumes[volumes.length - 1];
  const avgVolume   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio    = avgVolume > 0 ? lastVolume / avgVolume : 0;
  const volumeOk    = volRatio >= 0.7;

  // Cruzamento RSI abaixo da signal line
  const rsiCrossDown = prevRsi >= prevSig && lastRsi < lastSig;

  // Cruzamento RSI acima da signal line (saída)
  const rsiCrossUp = prevRsi <= prevSig && lastRsi > lastSig;

  // Preço acima da EMA200 no 1h
  const aboveEma200 = lastClose > lastEma200;

  return {
    rsi: lastRsi,
    rsiSignal: lastSig,
    ema200: lastEma200,
    volRatio,
    volumeOk,
    hadPump,
    rsiCrossDown,
    rsiCrossUp,
    aboveEma200,
    price: lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 225) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 225)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saída de posição short
  if (currentPosition === 'short') {
    if (ind.rsiCrossUp || ind.rsi < 30) {
      return {
        signal: 'close_short',
        reason: `Saída short: RSI=${ind.rsi.toFixed(1)} cruzou acima signal ou oversold`,
        indicators: ind,
      };
    }
  }

  // Entrada SHORT
  // Condições: preço > EMA200 1h + RSI cruza abaixo signal + volume >= 0.7x
  if (!currentPosition) {
    if (ind.aboveEma200 && ind.rsiCrossDown && ind.volumeOk) {
      return {
        signal: 'short',
        reason: `EMA200=${ind.ema200.toFixed(4)} · RSI(${ind.rsi.toFixed(1)}) cruzou↓ Signal(${ind.rsiSignal.toFixed(1)}) · Vol=${ind.volRatio.toFixed(1)}x`,
        indicators: ind,
      };
    }
  }

  // Hold — indica o que falta
  const missing = [];
  if (!ind.aboveEma200)   missing.push(`preço abaixo EMA200(${ind.ema200.toFixed(4)})`);
  if (!ind.rsiCrossDown)  missing.push(`RSI(${ind.rsi.toFixed(1)}) não cruzou abaixo signal(${ind.rsiSignal.toFixed(1)})`);
  if (!ind.volumeOk)      missing.push(`Vol=${ind.volRatio.toFixed(1)}x<0.7`);

  return {
    signal: 'hold',
    reason: `Hold: ${missing.join(' · ')}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
