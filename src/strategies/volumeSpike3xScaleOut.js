// Pedida pelo utilizador (03/09): entra LONG sobre o universo do scanner
// "Lista 50" (src/backtests/data/top50-6month-movers.json — os 50 símbolos
// com maior subida nos últimos 6 meses, já em queda >40% do pico) sempre
// que uma vela de 15m tiver volume > 3x a média das 10 velas anteriores
// (mesmo cálculo do scanner, ver src/services/scanner.js startScanVolatile50
// — aqui com limiar mais baixo, 3x em vez do "spike" de 5x, para entrar mais
// cedo). Exige fecho acima da abertura na mesma vela como confirmação de
// direção (sem isto, um pico de volume vermelho também dispararia long —
// não fazia sentido para uma entrada de tendência). Gestão de posição (SL
// 4%, TP1 8%/30%, TP2 45%/30%) fica em src/services/runner.js
// (stopLossPct + takeProfitTiers) — este módulo só decide entrada e a saída
// final do que sobrar depois dos dois TPs: quando o preço fecha abaixo da
// EMA(50) de 15m (corrigido em 03/09 — era SMA por engano).
//
// Nunca corrida nem testada ao vivo — arranca só em estudo (enabled:false).
const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'VolumeSpike3xScaleOut';

const VOLUME_RATIO_MIN = 3;
const MA_PERIOD = 50;

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const opens   = candles.map(c => c.open);

  const price = closes[closes.length - 1];
  const open  = opens[opens.length - 1];

  const priorVolumes = volumes.slice(-11, -1); // 10 velas antes da atual
  const avgVolume10   = priorVolumes.length ? priorVolumes.reduce((a, v) => a + v, 0) / priorVolumes.length : 0;
  const volumeRatio    = avgVolume10 > 0 ? volumes[volumes.length - 1] / avgVolume10 : 0;

  const emaArr = EMA.calculate({ period: MA_PERIOD, values: closes });
  const ema50  = emaArr[emaArr.length - 1];
  const belowMa50 = ema50 != null && price < ema50;

  const bullishCandle = price > open;
  const validEntry = volumeRatio >= VOLUME_RATIO_MIN && bullishCandle;

  return { price, open, avgVolume10, volumeRatio, ema50, belowMa50, bullishCandle, validEntry };
}

function generateSignal(candles, currentPosition = null) {
  const minCandles = MA_PERIOD + 12;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.validEntry) {
      return {
        signal: 'long',
        reason: `Volume ${ind.volumeRatio.toFixed(1)}x a média (>=${VOLUME_RATIO_MIN}x) · vela de alta — entra long`,
        indicators: ind,
      };
    }
    return {
      signal: 'hold',
      reason: `Volume ${ind.volumeRatio.toFixed(1)}x a média (${ind.volumeRatio >= VOLUME_RATIO_MIN ? 'vela sem confirmar alta' : `<${VOLUME_RATIO_MIN}x`})`,
      indicators: ind,
    };
  }

  // Saída do que sobrar depois dos TPs parciais (ver runner.js
  // takeProfitTiers): fecha quando o preço cai abaixo da EMA50.
  if (currentPosition === 'long' && ind.belowMa50) {
    return {
      signal: 'close_long',
      reason: `Preço (${ind.price.toFixed(6)}) caiu abaixo da EMA${MA_PERIOD}(${ind.ema50.toFixed(6)}) — fecha o resto da posição`,
      indicators: ind,
    };
  }

  return {
    signal: 'hold',
    reason: `Mantém long — preço ${ind.price.toFixed(6)} ${ind.ema50 != null ? (ind.price >= ind.ema50 ? '>=' : '<') : '?'} EMA${MA_PERIOD}=${ind.ema50?.toFixed(6)}`,
    indicators: ind,
  };
}

module.exports = { STRATEGY_NAME, VOLUME_RATIO_MIN, MA_PERIOD, generateSignal, calculateIndicators };
