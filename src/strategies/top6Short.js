const { SMA } = require('technicalindicators');

const STRATEGY_NAME = 'Top6SHORT';
const SMA_PERIOD = 15;
const THRESHOLD_PCT = 0.5; // % de distância mínima ao preço da SMA para disparar entrada/inversão

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const smaArr = SMA.calculate({ period: SMA_PERIOD, values: closes });

  const price = closes[closes.length - 1];
  const sma = smaArr[smaArr.length - 1];
  const spreadPct = ((price - sma) / sma) * 100;

  return {
    price, sma, spreadPct,
    belowBand: spreadPct <= -THRESHOLD_PCT,
    aboveBand: spreadPct >= THRESHOLD_PCT,
  };
}

// Universo: Top 6 de ganhos 24h (gainers24h). Sem gatilho de entrada por
// ranking — só reage ao preço face à SMA(15), com uma banda de ±0.5%
// (mesma ideia da CLOEmaFlip) para não inverter em cada cruzamento por
// ruído: entra SHORT quando o fecho está pelo menos 0.5% abaixo da SMA(15),
// inverte para LONG quando fica pelo menos 0.5% acima (e vice-versa depois
// de já estar posicionada). Dentro da banda não faz nada, só mantém o que
// já estiver aberto. Stop-loss de 7% anexado à ordem na Bybit.
function generateSignal(candles, currentPosition = null) {
  const minCandles = SMA_PERIOD + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.belowBand) {
      return {
        signal: 'short',
        reason: `Fecho (${ind.price.toFixed(6)}) ${ind.spreadPct.toFixed(2)}% abaixo da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)})`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: `Spread=${ind.spreadPct.toFixed(2)}% dentro da banda (±${THRESHOLD_PCT}%) — sem entrada`, indicators: ind };
  }

  if (currentPosition === 'short' && ind.aboveBand) {
    return {
      signal: 'flip_to_long',
      reason: `Fecho (${ind.price.toFixed(6)}) ${ind.spreadPct.toFixed(2)}% acima da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — inverte para long`,
      indicators: ind,
    };
  }
  if (currentPosition === 'long' && ind.belowBand) {
    return {
      signal: 'flip_to_short',
      reason: `Fecho (${ind.price.toFixed(6)}) ${ind.spreadPct.toFixed(2)}% abaixo da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — inverte para short`,
      indicators: ind,
    };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — spread=${ind.spreadPct.toFixed(2)}%`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
