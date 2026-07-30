const { SMA } = require('technicalindicators');

const STRATEGY_NAME = 'Top6SHORT';
const SMA_PERIOD = 15;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const smaArr = SMA.calculate({ period: SMA_PERIOD, values: closes });

  const price = closes[closes.length - 1];
  const sma = smaArr[smaArr.length - 1];

  return {
    price, sma,
    belowSma: price < sma,
    aboveSma: price > sma,
  };
}

// Universo: Top 6 de ganhos 24h (gainers24h). Sem gatilho de entrada por
// ranking — só reage ao preço face à SMA(15): entra SHORT quando o fecho
// está abaixo da SMA(15), inverte para LONG quando cruza de volta para cima
// (e vice-versa depois de já estar posicionada). Stop-loss de 7% anexado à
// ordem na Bybit.
function generateSignal(candles, currentPosition = null) {
  const minCandles = SMA_PERIOD + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.belowSma) {
      return {
        signal: 'short',
        reason: `Fecho (${ind.price.toFixed(6)}) abaixo da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)})`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: `Fecho (${ind.price.toFixed(6)}) acima da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — sem entrada`, indicators: ind };
  }

  if (currentPosition === 'short' && ind.aboveSma) {
    return {
      signal: 'flip_to_long',
      reason: `Fecho (${ind.price.toFixed(6)}) cruzou acima da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — inverte para long`,
      indicators: ind,
    };
  }
  if (currentPosition === 'long' && ind.belowSma) {
    return {
      signal: 'flip_to_short',
      reason: `Fecho (${ind.price.toFixed(6)}) cruzou abaixo da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — inverte para short`,
      indicators: ind,
    };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — preço ${ind.aboveSma ? 'acima' : 'abaixo'} da SMA${SMA_PERIOD}`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
