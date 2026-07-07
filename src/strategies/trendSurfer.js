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

  // Volume minimo 1.2x - acima de 1.2x avg=+2.24%, abaixo avg=-1.79%
  const volumeOk = volRatio >= 1.2;

  const c0 = closes[closes.length - 1];
  const c1 = closes[closes.length - 2];
  const c2 = closes[closes.length - 3];
  const candleUp   = c0 > c1 && c0 > c2;
  const candleDown = c0 < c1 && c0 < c2;

  const trend1h = lastEma12 > lastEma30 ? 'bull' : 'bear';

  // RSI 40-52: RSI<50 tem 100% WR (+9.56%), RSI>50 e negativo
  const rsiLong       = lastRsi >= 40 && lastRsi <= 52;
  const rsiOverbought = lastRsi > 72;
  const rsiOversold   = lastRsi < 28;

  return {
    ema12: lastEma12, ema30: lastEma30, ema80: lastEma80,
    rsi: lastRsi, volRatio, volumeOk, candleUp, candleDown,
    trend1h, rsiLong, rsiOverbought, rsiOversold,
    price: lastClose,
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 90) {
    return { signal: 'none', reason: 'Candles insuficientes (minimo 90)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.trend1h === 'bull' && ind.rsiLong && ind.volumeOk) {
      return {
        signal: 'long',
        reason: `EMA12(${ind.ema12.toFixed(4)}) > EMA30(${ind.ema30.toFixed(4)}) · RSI=${ind.rsi.toFixed(1)} · Vol=${ind.volRatio.toFixed(1)}x`,
        indicators: ind,
      };
    }
  }

  // Saida de posicao long quando tendencia inverte
  if (currentPosition === 'long' && ind.trend1h === 'bear' && ind.rsi < 45) {
    return {
      signal: 'close_long',
      reason: `Tendencia 1h invertida para bear + RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Hold: indica porque nao entrou
  const missing = [];
  if (ind.trend1h === 'bull') {
    if (!ind.rsiLong)  missing.push(`RSI=${ind.rsi.toFixed(1)} fora 40-52`);
    if (!ind.volumeOk) missing.push(`Vol=${ind.volRatio.toFixed(1)}x<1.2`);
  } else {
    missing.push('tendencia bear - aguardar recuperacao');
  }

  return {
    signal: 'hold',
    reason: `Hold: EMA12=${ind.ema12.toFixed(4)} ${ind.trend1h === 'bull' ? '>' : '<'} EMA30=${ind.ema30.toFixed(4)} · ${missing.join(' · ')}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
