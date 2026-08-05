const { Stochastic, SMA } = require('technicalindicators');

const STRATEGY_NAME = 'Stoch50';
const K_LENGTH = 50;
const K_SMOOTH = 40;
const D_SMOOTH = 11;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  // A lib só dá %K bruto + SMA(%K) como "%D" — para replicar o Stochastic
  // "lento" do TradingView (K 50, suavização 9, %D 9) suavizamos o %K bruto
  // nós próprios antes de aplicar a segunda SMA para o %D.
  const rawK = Stochastic.calculate({ high: highs, low: lows, close: closes, period: K_LENGTH, signalPeriod: 1 }).map(s => s.k);
  const kArr = SMA.calculate({ period: K_SMOOTH, values: rawK });
  const dArr = SMA.calculate({ period: D_SMOOTH, values: kArr });

  const k0 = kArr[kArr.length - 1];
  const k1 = kArr[kArr.length - 2];
  const d0 = dArr[dArr.length - 1];
  const d1 = dArr[dArr.length - 2];

  return {
    k: k0, d: d0,
    crossUp: k1 <= d1 && k0 > d0,
    crossDown: k1 >= d1 && k0 < d0,
  };
}

// Compra quando %K cruza acima de %D, vende quando cruza abaixo — sem filtro,
// qualquer cruzamento é válido. Sempre posicionada: sem cruzamento mantém o
// que já estiver aberto.
function generateSignal(candles, currentPosition = null) {
  const minCandles = K_LENGTH + K_SMOOTH + D_SMOOTH + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.crossUp) {
      return {
        signal: 'long',
        reason: `%K(${ind.k.toFixed(1)}) cruzou acima de %D(${ind.d.toFixed(1)})`,
        indicators: ind,
      };
    }
    if (ind.crossDown) {
      return {
        signal: 'short',
        reason: `%K(${ind.k.toFixed(1)}) cruzou abaixo de %D(${ind.d.toFixed(1)})`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: `Sem cruzamento válido — %K=${ind.k?.toFixed(1)}, %D=${ind.d?.toFixed(1)}`, indicators: ind };
  }

  if (currentPosition === 'long' && ind.crossDown) {
    return { signal: 'flip_to_short', reason: `%K cruzou abaixo de %D(${ind.d.toFixed(1)}) — fecha long, abre short`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.crossUp) {
    return { signal: 'flip_to_long', reason: `%K cruzou acima de %D(${ind.d.toFixed(1)}) — fecha short, abre long`, indicators: ind };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — %K=${ind.k?.toFixed(1)}, %D=${ind.d?.toFixed(1)}`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
