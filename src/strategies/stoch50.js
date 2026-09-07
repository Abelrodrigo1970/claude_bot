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

// Compra quando %K cruza acima de %D; o cruzamento para baixo fecha o long e,
// só se o QQQ estiver negativo nesse momento, abre um short. Sem cruzamento
// mantém o que já estiver aberto.
//
// Long-only entre 14/08 e 07/09 — o estudo original (janela de 10 dias) dizia
// que o short não tinha edge em regime nenhum. O reestudo de 07/09 sobre 90
// dias (src/backtests/study-stoch50-qqq-directional.js) mostrou o contrário:
// os shorts limitados às horas de QQQ negativo somam +305 USDT (PF 1.55). A
// melhor variante testada — "long sempre + short só em QQQ- na hora" — deu
// +682 vs +377 do long-only (PF 1.44 vs 1.38, drawdown -129 vs -151).
// context.qqqPositive vem do runner (getQqqPositive: preço do QQQ na hora vs
// fecho da véspera); qqqPositive === false => QQQ negativo => short permitido.
// Sem esse dado (chamadas de estudo sem context) o short fica bloqueado —
// comporta-se como long-only.
function generateSignal(candles, currentPosition = null, context = {}) {
  const minCandles = K_LENGTH + K_SMOOTH + D_SMOOTH + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);
  const kL = ind.k?.toFixed(1), dL = ind.d?.toFixed(1);
  const qqqNegative = context.qqqPositive === false; // short só é permitido com o QQQ a cair na hora

  if (!currentPosition) {
    if (ind.crossUp) {
      return { signal: 'long', reason: `%K(${kL}) cruzou acima de %D(${dL}) — entra long`, indicators: ind };
    }
    if (ind.crossDown && qqqNegative) {
      return { signal: 'short', reason: `%K(${kL}) cruzou abaixo de %D(${dL}) · QQQ negativo na hora — entra short`, indicators: ind };
    }
    if (ind.crossDown) {
      return { signal: 'hold', reason: `%K cruzou abaixo de %D mas QQQ não está negativo — sem short`, indicators: ind };
    }
    return { signal: 'hold', reason: `Sem cruzamento de entrada — %K=${kL}, %D=${dL}`, indicators: ind };
  }

  if (currentPosition === 'long' && ind.crossDown) {
    return qqqNegative
      ? { signal: 'flip_to_short', reason: `%K cruzou abaixo de %D(${dL}) · QQQ negativo — fecha long e inverte para short`, indicators: ind }
      : { signal: 'close_long', reason: `%K cruzou abaixo de %D(${dL}) — fecha long`, indicators: ind };
  }

  if (currentPosition === 'short' && ind.crossUp) {
    return { signal: 'flip_to_long', reason: `%K(${kL}) cruzou acima de %D(${dL}) — fecha short e inverte para long`, indicators: ind };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — %K=${kL}, %D=${dL}`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
