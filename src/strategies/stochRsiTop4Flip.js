const { StochasticRSI, SMA } = require('technicalindicators');

const STRATEGY_NAME = 'StochRSITop4Flip';

const RSI_PERIOD    = 50;
const STOCH_PERIOD  = 50;
const K_SMOOTH       = 40;
const D_SMOOTH       = 11;
const TOP_N          = 4;
const MA_PERIOD      = 21;
const MA_DIST_PCT    = 1; // % mínimo abaixo da MA21 para abrir SHORT no fecho do LONG

const TIMEFRAME_MS = 60 * 60 * 1000;

// A vela mais recente devolvida pela Bybit/ccxt costuma ainda estar em
// formação — descarta-a para que os cálculos usem só velas 1h já fechadas
// ("usa só velas fechadas").
function closedCandlesOnly(candles) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  const closesAt = last.time.getTime() + TIMEFRAME_MS;
  return closesAt > Date.now() ? candles.slice(0, -1) : candles;
}

// StochasticRSI da lib já encadeia RSI(rsiPeriod) → Stochastic(RSI) →
// SMA(kPeriod) → SMA(dPeriod) — exatamente a receita pedida (RSI 50 / Stoch
// 50 / SmoothK 40 / SmoothD 11). output.k é o %K já suavizado, output.d é o
// %D. Cruzamento comparado barra anterior vs. atual, como pedido.
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const stochRsi = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: RSI_PERIOD,
    stochasticPeriod: STOCH_PERIOD,
    kPeriod: K_SMOOTH,
    dPeriod: D_SMOOTH,
  });

  const k0 = stochRsi[stochRsi.length - 1]?.k;
  const k1 = stochRsi[stochRsi.length - 2]?.k;
  const d0 = stochRsi[stochRsi.length - 1]?.d;
  const d1 = stochRsi[stochRsi.length - 2]?.d;
  const hasCross = k0 != null && k1 != null && d0 != null && d1 != null;

  const ma21Arr = SMA.calculate({ period: MA_PERIOD, values: closes });
  const ma21  = ma21Arr[ma21Arr.length - 1];
  const price = closes[closes.length - 1];
  const distToMa21Pct = ma21 ? ((price - ma21) / ma21) * 100 : null;

  return {
    k: k0, d: d0,
    crossUp:   hasCross && k1 <= d1 && k0 > d0,
    crossDown: hasCross && k1 >= d1 && k0 < d0,
    ma21, price, distToMa21Pct,
    belowMa21: distToMa21Pct != null && distToMa21Pct <= -MA_DIST_PCT,
  };
}

// LONG: %K cruza acima de %D. Se a estratégia estiver ligada a um ranking
// (context.rank vem do scanner "Top ganhos 24h"), só entra dentro do TopN;
// sem ranking (ex: lista fixa de símbolos), o próprio conjunto de símbolos
// avaliado já é o filtro, por isso a entrada fica sempre elegível. Só entra
// se ainda não há LONG aberto; se houver SHORT, inverte (fecha short, abre
// long) — SL do long é -5% (stopLossLongPct no registo).
//
// Fecho: quando há LONG aberto e %K cruza abaixo de %D, fecha sempre o long.
// Só abre SHORT nesse momento se o preço estiver ≥1% abaixo da MA21(1h);
// caso contrário fica flat. SL do short é +7% (stopLossShortPct). Sem TP em
// nenhum dos lados.
//
// Nota: um SHORT aberto só é fechado por reversão (novo cruzamento para
// cima, respeitando o mesmo filtro de ranking se existir) ou pelo SL — não
// há saída por o símbolo sair do ranking/lista, replicando a regra tal como
// pedida.
function generateSignal(candles, currentPosition = null, context = {}) {
  const closed = closedCandlesOnly(candles);
  const minCandles = RSI_PERIOD + STOCH_PERIOD + K_SMOOTH + D_SMOOTH + 5;
  if (closed.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(closed);
  const rank = context.rank ?? null;
  const rankOk = rank != null ? rank <= TOP_N : true;

  if (currentPosition !== 'long' && rankOk && ind.crossUp) {
    return {
      signal: currentPosition === 'short' ? 'flip_to_long' : 'long',
      reason: rank != null
        ? `Top${TOP_N} (rank ${rank}) · %K(${ind.k.toFixed(1)}) cruzou acima de %D(${ind.d.toFixed(1)})`
        : `%K(${ind.k.toFixed(1)}) cruzou acima de %D(${ind.d.toFixed(1)})`,
      indicators: ind,
    };
  }

  if (currentPosition === 'long' && ind.crossDown) {
    if (ind.belowMa21) {
      return {
        signal: 'flip_to_short',
        reason: `%K(${ind.k.toFixed(1)}) cruzou abaixo de %D(${ind.d.toFixed(1)}) · preço ${ind.distToMa21Pct.toFixed(2)}% da MA${MA_PERIOD} (≥${MA_DIST_PCT}% abaixo) — fecha long, abre short`,
        indicators: ind,
      };
    }
    return {
      signal: 'close_long',
      reason: `%K(${ind.k.toFixed(1)}) cruzou abaixo de %D(${ind.d.toFixed(1)}) · preço ${ind.distToMa21Pct != null ? ind.distToMa21Pct.toFixed(2) : '?'}% da MA${MA_PERIOD} (<${MA_DIST_PCT}% abaixo) — fecha long sem abrir short`,
      indicators: ind,
    };
  }

  return {
    signal: 'hold',
    reason: `Mantém ${currentPosition || 'flat'}${rank != null ? ` — rank=${rank}` : ''} · %K=${ind.k?.toFixed(1)} · %D=${ind.d?.toFixed(1)}`,
    indicators: ind,
  };
}

module.exports = { STRATEGY_NAME, TOP_N, generateSignal, calculateIndicators };
