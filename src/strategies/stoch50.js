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

// Compra quando %K cruza acima de %D, fecha quando cruza abaixo — sem filtro,
// qualquer cruzamento de entrada é válido. Sem cruzamento mantém o que já
// estiver aberto.
//
// Long-only desde 14/08 — estudo dia-a-dia comparando com o QQQ (Nasdaq):
// o short perdia dinheiro tanto em dias QQQ+ (-59.03 USDT) como QQQ- (-46.32
// USDT), ou seja, não era um problema de regime de mercado como na
// EMA90TopFade — o lado short desta estratégia não tem edge. No mesmo
// período, long-only teria dado +147.80 USDT vs. +42.44 real (long+short) e
// +101.47 com um filtro QQQ testado — desligar o short de vez é a melhor das
// três opções.
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
    return { signal: 'hold', reason: `Sem cruzamento de entrada (long-only) — %K=${ind.k?.toFixed(1)}, %D=${ind.d?.toFixed(1)}`, indicators: ind };
  }

  if (ind.crossDown) {
    return { signal: 'close_long', reason: `%K cruzou abaixo de %D(${ind.d.toFixed(1)}) — fecha long (estratégia é long-only)`, indicators: ind };
  }

  return { signal: 'hold', reason: `Mantém long — %K=${ind.k?.toFixed(1)}, %D=${ind.d?.toFixed(1)}`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
