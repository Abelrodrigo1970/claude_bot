const { SMA } = require('technicalindicators');

const STRATEGY_NAME = 'Top6LONG';
const TOP_N = 6;
const SMA_PERIOD = 15;
const THRESHOLD_PCT = 0.5; // % de distância mínima ao preço da SMA para inverter

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

// Entra LONG assim que o símbolo entra no Top 6 de ganhos 24h (rank vem em
// context.rank, calculado no runner a partir do scanner de gainers24h).
// Depois de posicionada, ignora o ranking e só olha para o preço face à
// SMA(15), com uma banda de ±0.5% (mesma ideia da CLOEmaFlip) para não
// inverter em cada cruzamento por ruído: inverte para SHORT quando o fecho
// fica pelo menos 0.5% abaixo, volta a LONG quando fica pelo menos 0.5%
// acima. Dentro da banda mantém a posição. Stop-loss de 7% anexado à ordem.
function generateSignal(candles, currentPosition = null, context = {}) {
  const minCandles = SMA_PERIOD + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const rank = context.rank ?? null;
  const inTopN = rank != null && rank <= TOP_N;
  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (inTopN) {
      return {
        signal: 'long',
        reason: `Entrou no Top ${TOP_N} de ganhos 24h (rank ${rank})`,
        indicators: { ...ind, rank },
      };
    }
    return { signal: 'hold', reason: `Fora do Top ${TOP_N} (rank ${rank ?? 'sem dados'})`, indicators: { ...ind, rank } };
  }

  if (currentPosition === 'long' && ind.belowBand) {
    return {
      signal: 'flip_to_short',
      reason: `Fecho (${ind.price.toFixed(6)}) ${ind.spreadPct.toFixed(2)}% abaixo da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — inverte para short`,
      indicators: { ...ind, rank },
    };
  }
  if (currentPosition === 'short' && ind.aboveBand) {
    return {
      signal: 'flip_to_long',
      reason: `Fecho (${ind.price.toFixed(6)}) ${ind.spreadPct.toFixed(2)}% acima da SMA${SMA_PERIOD} (${ind.sma.toFixed(6)}) — inverte para long`,
      indicators: { ...ind, rank },
    };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — spread=${ind.spreadPct.toFixed(2)}%`, indicators: { ...ind, rank } };
}

module.exports = { STRATEGY_NAME, TOP_N, generateSignal, calculateIndicators };
