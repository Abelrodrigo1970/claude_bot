/**
 * TREND SURFER STRATEGY (Scanner Edition)
 * ----------------------------------------
 * Otimizada para símbolos pré-filtrados pelo Scanner EMA90 diário
 * (já confirmados em tendência de alta no daily).
 *
 * No 1h, procura entradas long quando o momentum de curto prazo confirma
 * a tendência, sem exigir crossover exato nem volume extraordinário.
 *
 * LÓGICA:
 * - LONG : EMA12 > EMA30 no 1h  +  RSI 40-65  +  volume > 0.7x
 * - SHORT: EMA12 < EMA30 no 1h  +  RSI 35-55  +  volume > 0.7x  (contra-tendência, mais raro)
 * - Flip : quando a posição aberta vai contra os EMAs + RSI extremo
 * - Hold : tudo o resto
 */

const { EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'TrendSurfer';

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema12 = EMA.calculate({ period: 12, values: closes });
  const ema30 = EMA.calculate({ period: 30, values: closes });
  const ema80 = EMA.calculate({ period: 80, values: closes });
  const rsi   = RSI.calculate({ period: 14, values: closes });

  const lastEma12 = ema12[ema12.length - 1];
  const lastEma30 = ema30[ema30.length - 1];
  const lastEma80 = ema80[ema80.length - 1];
  const lastRsi   = rsi[rsi.length - 1];
  const lastClose = closes[closes.length - 1];

  const recentVols = volumes.slice(-20);
  const avgVolume  = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const lastVolume = volumes[volumes.length - 1];
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;
  const volumeOk   = volRatio >= 0.7;

  // Confirmação de momentum: última vela acima/abaixo das 2 anteriores
  const c0 = closes[closes.length - 1]; // vela atual
  const c1 = closes[closes.length - 2]; // vela anterior
  const c2 = closes[closes.length - 3]; // 2 velas atrás
  const candleUp   = c0 > c1 && c0 > c2; // preço a subir vs últimas 2
  const candleDown = c0 < c1 && c0 < c2; // preço a cair vs últimas 2

  // Tendência no 1h
  const trend1h = lastEma12 > lastEma30 ? 'bull' : 'bear';

  // Zonas RSI
  const rsiLong  = lastRsi >= 40 && lastRsi <= 68;
  const rsiShort = lastRsi >= 32 && lastRsi <= 60;
  const rsiOverbought = lastRsi > 72;
  const rsiOversold   = lastRsi < 28;

  return {
    ema12: lastEma12, ema30: lastEma30, ema80: lastEma80,
    rsi: lastRsi, volRatio, volumeOk, candleUp, candleDown,
    trend1h, rsiLong, rsiShort, rsiOverbought, rsiOversold,
    price: lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 90) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 90)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // ── Scanner EMA90 confirma uptrend diário → só LONG ────────────

  // ENTRADA nova sem posição
  if (!currentPosition) {
    if (ind.trend1h === 'bull' && ind.rsiLong && ind.volumeOk && ind.candleUp) {
      return {
        signal: 'long',
        reason: `EMA12(${ind.ema12.toFixed(4)}) > EMA30(${ind.ema30.toFixed(4)}) · RSI=${ind.rsi.toFixed(1)} · Vol=${ind.volRatio.toFixed(1)}x · vela↑`,
        indicators: ind,
      };
    }
  }

  // Saída de posição long quando tendência inverte
  if (currentPosition === 'long' && ind.trend1h === 'bear' && ind.rsi < 45) {
    return {
      signal: 'close_long',
      reason: `Tendência 1h invertida para bear + RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Hold: indica porquê não entrou
  const missing = [];
  if (ind.trend1h === 'bull') {
    if (!ind.rsiLong)  missing.push(`RSI=${ind.rsi.toFixed(1)} fora 40-68`);
    if (!ind.volumeOk) missing.push(`Vol=${ind.volRatio.toFixed(1)}x<0.7`);
    if (!ind.candleUp) missing.push('vela não confirma ↑');
  } else {
    missing.push('tendência bear — scanner EMA90 garante uptrend, aguardar recuperação');
  }

  return {
    signal: 'hold',
    reason: `Hold: EMA12=${ind.ema12.toFixed(4)} ${ind.trend1h === 'bull' ? '>' : '<'} EMA30=${ind.ema30.toFixed(4)} · ${missing.join(' · ')}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
