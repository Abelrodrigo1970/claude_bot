const { RSI, SMA } = require('technicalindicators');

const STRATEGY_NAME = 'StockSMA';
const RSI_PERIOD   = 14;
const SMA_PERIOD   = 18;
const MIN_GAP      = 0.8; // pontos mínimos de inversão na SMA do RSI

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const smaArr = SMA.calculate({ period: SMA_PERIOD, values: rsiArr }); // SMA(18) do RSI

  const sma0 = smaArr[smaArr.length - 1]; // atual
  const sma1 = smaArr[smaArr.length - 2]; // vela anterior (possível pico/vale)
  const sma2 = smaArr[smaArr.length - 3]; // 2 velas atrás

  // Inversão para baixo: estava a subir (sma2→sma1), agora desce (sma1→sma0)
  // ex: sma2=64.5, sma1=65.9, sma0=65.1 → inversão de 0.8 → SHORT
  const invertDown = sma1 > sma2 && sma0 < sma1;
  const gapDown    = sma1 - sma0; // quanto desceu desde o pico
  const validShort = invertDown && gapDown >= MIN_GAP;

  // Inversão para cima: estava a descer (sma2→sma1), agora sobe (sma1→sma0)
  const invertUp  = sma1 < sma2 && sma0 > sma1;
  const gapUp     = sma0 - sma1; // quanto subiu desde o vale
  const validLong = invertUp && gapUp >= MIN_GAP;

  // Saídas: nova inversão contrária
  const newInvertDown = invertDown; // pode fechar long
  const newInvertUp   = invertUp;   // pode fechar short

  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;
  const lastRsi    = rsiArr[rsiArr.length - 1];

  return {
    rsi: lastRsi,
    sma: sma0,
    smaPeak: sma1,
    smaDir: sma0 > sma1 ? 'up' : 'down',
    invertDown,
    invertUp,
    gapDown,
    gapUp,
    validLong,
    validShort,
    volRatio,
    price: closes[closes.length - 1],
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < RSI_PERIOD + SMA_PERIOD + 5) {
    return { signal: 'none', reason: 'Candles insuficientes', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saída de long → SMA inverteu para baixo
  if (currentPosition === 'long' && ind.invertDown && ind.gapDown >= MIN_GAP) {
    return {
      signal: 'close_long',
      reason: `SMA(18) inverteu↓ pico=${ind.smaPeak.toFixed(1)} → atual=${ind.sma.toFixed(1)} (${ind.gapDown.toFixed(1)}pts)`,
      indicators: ind,
    };
  }

  // Saída de short → SMA inverteu para cima
  if (currentPosition === 'short' && ind.invertUp && ind.gapUp >= MIN_GAP) {
    return {
      signal: 'close_short',
      reason: `SMA(18) inverteu↑ vale=${ind.smaPeak.toFixed(1)} → atual=${ind.sma.toFixed(1)} (${ind.gapUp.toFixed(1)}pts)`,
      indicators: ind,
    };
  }

  // Entrada LONG
  if (!currentPosition && ind.validLong) {
    return {
      signal: 'long',
      reason: `SMA(18) inverteu↑ ${ind.smaPeak.toFixed(1)}→${ind.sma.toFixed(1)} (+${ind.gapUp.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Entrada SHORT
  if (!currentPosition && ind.validShort) {
    return {
      signal: 'short',
      reason: `SMA(18) inverteu↓ ${ind.smaPeak.toFixed(1)}→${ind.sma.toFixed(1)} (-${ind.gapDown.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Hold
  const dir    = ind.smaDir === 'up' ? `↑ ${ind.sma.toFixed(1)}` : `↓ ${ind.sma.toFixed(1)}`;
  const gap    = ind.invertDown ? `gap=${ind.gapDown.toFixed(2)}<${MIN_GAP}` :
                 ind.invertUp   ? `gap=${ind.gapUp.toFixed(2)}<${MIN_GAP}` : 'sem inversão';

  return {
    signal: 'hold',
    reason: `Hold: SMA(18)=${dir} · ${gap}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
