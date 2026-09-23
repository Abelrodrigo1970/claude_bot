// Lista 50 spike LONG — SMA50↑ + BTC 4h verde.
//
// Entrada (vela 15m fechada, universo top50-6month-movers):
//   1. volume ≥ 5× média das 10 velas anteriores
//   2. vela verde (close > open)
//   3. close > SMA(50)
//   4. SMA(50) a subir vs. 10 barras atrás
//   5. BTC 4h verde (context.btc4hGreen — runner btc4hGreenFilter)
//
// Gestão (em runner.js, não aqui):
//   SL 12% · TP parcial 30% @ +15% · resto às 48h (maxHoldHours)
//
// Estudo 60d (study-lista50-spike-btc-filter.js) — melhor qualidade:
//   ~266 trades, PF ~1.92, PnL ~+704, maxDD ~-186
//   (vs baseline PF 1.29 / +747 com mais perdas e DD −368)
// Nunca corrida ao vivo — arranca enabled:false.
const { SMA } = require('technicalindicators');

const STRATEGY_NAME = 'Lista50SpikeSmaRise';

const VOLUME_RATIO_MIN = 5;
const VOL_LOOKBACK = 10;
const MA_PERIOD = 50;
const MA_SLOPE_BARS = 10;

function calculateIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const opens = candles.map((c) => c.open);

  const price = closes[closes.length - 1];
  const open = opens[opens.length - 1];

  const priorVolumes = volumes.slice(-(VOL_LOOKBACK + 1), -1);
  const avgVolume10 = priorVolumes.length
    ? priorVolumes.reduce((a, v) => a + v, 0) / priorVolumes.length
    : 0;
  const volumeRatio = avgVolume10 > 0 ? volumes[volumes.length - 1] / avgVolume10 : 0;

  const smaArr = SMA.calculate({ period: MA_PERIOD, values: closes });
  const sma50 = smaArr[smaArr.length - 1];
  const sma50Prev = smaArr[smaArr.length - 1 - MA_SLOPE_BARS];
  const maRising = sma50 != null && sma50Prev != null && sma50 > sma50Prev;
  const maSlopePct =
    sma50 != null && sma50Prev != null && sma50Prev !== 0
      ? ((sma50 - sma50Prev) / sma50Prev) * 100
      : null;
  const aboveSma50 = sma50 != null && price > sma50;
  const aboveMaPct =
    sma50 != null && sma50 !== 0 ? ((price - sma50) / sma50) * 100 : null;

  const bullishCandle = price > open;
  // BTC 4h verde vem do context no generateSignal (não das velas do símbolo).
  const validEntryLocal =
    volumeRatio >= VOLUME_RATIO_MIN && bullishCandle && aboveSma50 && maRising;

  return {
    price,
    open,
    avgVolume10,
    volumeRatio,
    sma50,
    sma50Prev,
    maRising,
    maSlopePct,
    aboveSma50,
    aboveMaPct,
    bullishCandle,
    validEntryLocal,
  };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  const minCandles = MA_PERIOD + MA_SLOPE_BARS + VOL_LOOKBACK + 2;
  if (candles.length < minCandles) {
    return {
      signal: 'none',
      reason: `Candles insuficientes (mínimo ${minCandles})`,
      indicators: {},
    };
  }

  const ind = calculateIndicators(candles);
  // Só bloqueia quando o runner passa false explícito (BTC 4h vermelha).
  // Sem dados / estudos sem context → não trava.
  const btc4hOk = context.btc4hGreen !== false;
  ind.btc4hGreen = context.btc4hGreen;
  ind.validEntry = ind.validEntryLocal && btc4hOk;

  // Saída do resto: SL / TP parcial / maxHoldHours no runner — aqui só hold.
  if (currentPosition === 'long') {
    return {
      signal: 'hold',
      reason: `Mantém long — gestão por SL12% / TP30%@+15% / fecho 48h (runner)`,
      indicators: ind,
    };
  }

  if (ind.validEntry) {
    return {
      signal: 'long',
      reason:
        `Spike ${ind.volumeRatio.toFixed(1)}x (≥${VOLUME_RATIO_MIN}x) · verde · ` +
        `close>SMA${MA_PERIOD} (+${ind.aboveMaPct?.toFixed(1)}%) · SMA↑ ` +
        `(${ind.maSlopePct?.toFixed(2)}% / ${MA_SLOPE_BARS} barras) · BTC 4h verde`,
      indicators: ind,
    };
  }

  const parts = [];
  if (ind.volumeRatio < VOLUME_RATIO_MIN) parts.push(`vol ${ind.volumeRatio.toFixed(1)}x<${VOLUME_RATIO_MIN}x`);
  else parts.push(`vol ${ind.volumeRatio.toFixed(1)}x`);
  if (!ind.bullishCandle) parts.push('vela vermelha');
  if (!ind.aboveSma50) parts.push(`close≤SMA${MA_PERIOD}`);
  if (!ind.maRising) parts.push(`SMA${MA_PERIOD} não sobe`);
  if (!btc4hOk) parts.push('BTC 4h vermelha');

  return {
    signal: 'hold',
    reason: parts.join(' · '),
    indicators: ind,
  };
}

module.exports = {
  STRATEGY_NAME,
  VOLUME_RATIO_MIN,
  VOL_LOOKBACK,
  MA_PERIOD,
  MA_SLOPE_BARS,
  generateSignal,
  calculateIndicators,
};
