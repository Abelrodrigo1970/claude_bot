const { EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'PumpBreaker';

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema200    = EMA.calculate({ period: 200, values: closes });
  const rsiArr    = RSI.calculate({ period: 14, values: closes });
  const rsiSignal = EMA.calculate({ period: 9, values: rsiArr });

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

  const rsiCrossDown = prevRsi >= prevSig && lastRsi < lastSig;
  const rsiCrossUp   = prevRsi <= prevSig && lastRsi > lastSig;

  const pctAboveEma200 = lastEma200 > 0 ? ((lastClose - lastEma200) / lastEma200) * 100 : 0;
  const aboveEma200    = pctAboveEma200 >= 20;

  // RSI devia estar em sobrecompra antes do cruzamento (prevRsi >= 60)
  // Evita entradas com RSI ja muito baixo (ex: DYDX RSI=44.8, DBR RSI=40.2)
  const rsiOverboughtBeforeCross = prevRsi >= 60;

  return {
    rsi: lastRsi,
    prevRsi,
    rsiSignal: lastSig,
    ema200: lastEma200,
    pctAboveEma200,
    volRatio,
    volumeOk,
    rsiCrossDown,
    rsiCrossUp,
    aboveEma200,
    rsiOverboughtBeforeCross,
    price: lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 225) {
    return { signal: 'none', reason: 'Candles insuficientes (minimo 225)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saida de posicao short
  if (currentPosition === 'short') {
    if (ind.rsiCrossUp || ind.rsi < 30) {
      return {
        signal: 'close_short',
        reason: `Saida short: RSI=${ind.rsi.toFixed(1)} cruzou acima signal ou oversold`,
        indicators: ind,
      };
    }
  }

  // Entrada SHORT
  // Condicoes: preco >20% EMA200 + RSI cruza abaixo signal + RSI estava em sobrecompra (>=60) + volume >= 0.7x
  if (!currentPosition) {
    if (ind.aboveEma200 && ind.rsiCrossDown && ind.rsiOverboughtBeforeCross && ind.volumeOk) {
      return {
        signal: 'short',
        reason: `+${ind.pctAboveEma200.toFixed(1)}% acima EMA200 · RSI(${ind.rsi.toFixed(1)}) cruzou abaixo Signal(${ind.rsiSignal.toFixed(1)}) · prevRSI=${ind.prevRsi.toFixed(1)} · Vol=${ind.volRatio.toFixed(1)}x`,
        indicators: ind,
      };
    }
  }

  // Hold - indica o que falta
  const missing = [];
  if (!ind.aboveEma200)                missing.push(`preco apenas +${ind.pctAboveEma200.toFixed(1)}% acima EMA200 (min 20%)`);
  if (!ind.rsiCrossDown)               missing.push(`RSI(${ind.rsi.toFixed(1)}) nao cruzou abaixo signal(${ind.rsiSignal.toFixed(1)})`);
  if (!ind.rsiOverboughtBeforeCross)   missing.push(`prevRSI=${ind.prevRsi.toFixed(1)}<60 (nao estava em sobrecompra)`);
  if (!ind.volumeOk)                   missing.push(`Vol=${ind.volRatio.toFixed(1)}x<0.7`);

  return {
    signal: 'hold',
    reason: `Hold: ${missing.join(' · ')}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
