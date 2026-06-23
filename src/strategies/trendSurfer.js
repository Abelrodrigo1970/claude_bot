/**
 * TREND SURFER STRATEGY
 * ---------------------
 * Baseado no gráfico BICOUSDT 1h com Pivot Boss 4 EMA (12, 30, 80, 200)
 * 
 * LÓGICA:
 * - Entra LONG quando o mercado começa a subir forte (EMA rápidas acima das lentas + volume)
 * - Inverte para SHORT quando deteta topo (EMA crossover descendente + volume a secar)
 * - Surfa tanto a alta como a baixa
 */

const { EMA, RSI, BollingerBands } = require('technicalindicators');

const STRATEGY_NAME = 'TrendSurfer';

/**
 * Calcula todos os indicadores necessários
 */
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema12 = EMA.calculate({ period: 12, values: closes });
  const ema30 = EMA.calculate({ period: 30, values: closes });
  const ema80 = EMA.calculate({ period: 80, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });

  // Volume médio das últimas 20 velas
  const recentVols = volumes.slice(-20);
  const avgVolume = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;

  // Alinhamento das EMAs (bullish quando ema12 > ema30 > ema80 > ema200)
  const lastEma12 = ema12[ema12.length - 1];
  const lastEma30 = ema30[ema30.length - 1];
  const lastEma80 = ema80[ema80.length - 1];
  const lastEma200 = ema200[ema200.length - 1];
  const lastRsi = rsi[rsi.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  const lastClose = closes[closes.length - 1];

  // Crossover detection: compara penúltimo vs último
  const prevEma12 = ema12[ema12.length - 2];
  const prevEma30 = ema30[ema30.length - 2];

  const bullishCrossover = prevEma12 <= prevEma30 && lastEma12 > lastEma30;
  const bearishCrossover = prevEma12 >= prevEma30 && lastEma12 < lastEma30;

  // Trend Matrix: força da tendência
  const emaBullishAlignment = lastEma12 > lastEma30 && lastEma30 > lastEma80 && lastEma80 > lastEma200;
  const emaBearishAlignment = lastEma12 < lastEma30 && lastEma30 < lastEma80 && lastEma80 < lastEma200;

  // Volume acima da média (confirma movimento)
  const volumeConfirm = lastVolume > avgVolume * 1.3;

  // Deteção de topo: RSI sobrecomprado + EMA começando a cruzar para baixo
  const topDetected = lastRsi > 70 && bearishCrossover && volumeConfirm;

  // Deteção de fundo: RSI sobrevendido + EMA cruzando para cima
  const bottomDetected = lastRsi < 30 && bullishCrossover && volumeConfirm;

  return {
    ema12: lastEma12,
    ema30: lastEma30,
    ema80: lastEma80,
    ema200: lastEma200,
    rsi: lastRsi,
    volume: lastVolume,
    avgVolume,
    volumeConfirm,
    bullishCrossover,
    bearishCrossover,
    emaBullishAlignment,
    emaBearishAlignment,
    topDetected,
    bottomDetected,
    price: lastClose,
  };
}

/**
 * Gera sinal de trading
 * @param {Array} candles - Array de candles OHLCV
 * @param {string|null} currentPosition - 'long' | 'short' | null
 * @returns {{ signal: string, reason: string, indicators: object }}
 */
function generateSignal(candles, currentPosition = null) {
  if (candles.length < 210) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 210)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // LÓGICA DE INVERSÃO (a core da estratégia)
  // Estamos LONG e detetamos topo -> inverter para SHORT
  if (currentPosition === 'long' && ind.topDetected) {
    return {
      signal: 'flip_to_short',
      reason: `Topo detetado: RSI=${ind.rsi.toFixed(1)} > 70, bearish crossover EMA12/30, volume ${(ind.volume / ind.avgVolume).toFixed(1)}x`,
      indicators: ind,
    };
  }

  // Estamos SHORT e detetamos fundo -> inverter para LONG
  if (currentPosition === 'short' && ind.bottomDetected) {
    return {
      signal: 'flip_to_long',
      reason: `Fundo detetado: RSI=${ind.rsi.toFixed(1)} < 30, bullish crossover EMA12/30, volume ${(ind.volume / ind.avgVolume).toFixed(1)}x`,
      indicators: ind,
    };
  }

  // ENTRADA INICIAL sem posição
  if (!currentPosition) {
    // Entrada long: EMAs alinhadas bullish + bullish crossover + volume
    if (ind.emaBullishAlignment && ind.bullishCrossover && ind.volumeConfirm) {
      return {
        signal: 'long',
        reason: `Entrada LONG: EMAs alinhadas bullish (${ind.ema12.toFixed(6)} > ${ind.ema30.toFixed(6)} > ${ind.ema80.toFixed(6)}), volume ${(ind.volume / ind.avgVolume).toFixed(1)}x`,
        indicators: ind,
      };
    }

    // Entrada short: EMAs alinhadas bearish + bearish crossover + volume
    if (ind.emaBearishAlignment && ind.bearishCrossover && ind.volumeConfirm) {
      return {
        signal: 'short',
        reason: `Entrada SHORT: EMAs alinhadas bearish, RSI=${ind.rsi.toFixed(1)}, volume ${(ind.volume / ind.avgVolume).toFixed(1)}x`,
        indicators: ind,
      };
    }
  }

  return {
    signal: 'hold',
    reason: `Hold: EMA12=${ind.ema12.toFixed(6)}, RSI=${ind.rsi.toFixed(1)}, Vol=${(ind.volume / ind.avgVolume).toFixed(1)}x da média`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
