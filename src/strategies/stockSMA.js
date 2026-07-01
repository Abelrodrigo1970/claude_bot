const { RSI, SMA } = require('technicalindicators');

const STRATEGY_NAME = 'StockSMA';
const RSI_PERIOD   = 14;
const SMA_PERIOD   = 18;
const MIN_GAP      = 0.8;  // pontos mínimos acumulados desde o pico/vale
const LOOKBACK     = 10;   // janela de velas para encontrar pico/vale recente

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const smaArr = SMA.calculate({ period: SMA_PERIOD, values: rsiArr });

  const sma0 = smaArr[smaArr.length - 1]; // atual
  const sma1 = smaArr[smaArr.length - 2]; // anterior

  // Direção atual da SMA
  const rising  = sma0 > sma1;
  const falling = sma0 < sma1;

  // Janela de LOOKBACK velas (excluindo a atual) para encontrar pico/vale
  const window = smaArr.slice(-(LOOKBACK + 1), -1);
  const localPeak   = Math.max(...window);
  const localTrough = Math.min(...window);

  // SHORT: SMA caiu >= 0.8 desde o pico recente E ainda está a cair
  const dropFromPeak   = localPeak - sma0;
  const validShort     = dropFromPeak >= MIN_GAP && falling;

  // LONG: SMA subiu >= 0.8 desde o vale recente E ainda está a subir
  const riseFromTrough = sma0 - localTrough;
  const validLong      = riseFromTrough >= MIN_GAP && rising;

  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;
  const lastRsi    = rsiArr[rsiArr.length - 1];

  return {
    rsi: lastRsi,
    sma: sma0,
    localPeak,
    localTrough,
    dropFromPeak,
    riseFromTrough,
    rising,
    falling,
    validLong,
    validShort,
    volRatio,
    price: closes[closes.length - 1],
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < RSI_PERIOD + SMA_PERIOD + LOOKBACK + 3) {
    return { signal: 'none', reason: 'Candles insuficientes', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saída de long → SMA a cair 0.8 desde o pico
  if (currentPosition === 'long' && ind.falling && ind.dropFromPeak >= MIN_GAP) {
    return {
      signal: 'close_long',
      reason: `SMA(18)↓ pico=${ind.localPeak.toFixed(1)} atual=${ind.sma.toFixed(1)} (-${ind.dropFromPeak.toFixed(1)}pts)`,
      indicators: ind,
    };
  }

  // Saída de short → SMA a subir 0.8 desde o vale
  if (currentPosition === 'short' && ind.rising && ind.riseFromTrough >= MIN_GAP) {
    return {
      signal: 'close_short',
      reason: `SMA(18)↑ vale=${ind.localTrough.toFixed(1)} atual=${ind.sma.toFixed(1)} (+${ind.riseFromTrough.toFixed(1)}pts)`,
      indicators: ind,
    };
  }

  // Entrada LONG
  if (!currentPosition && ind.validLong) {
    return {
      signal: 'long',
      reason: `SMA(18)↑ vale=${ind.localTrough.toFixed(1)}→${ind.sma.toFixed(1)} (+${ind.riseFromTrough.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Entrada SHORT
  if (!currentPosition && ind.validShort) {
    return {
      signal: 'short',
      reason: `SMA(18)↓ pico=${ind.localPeak.toFixed(1)}→${ind.sma.toFixed(1)} (-${ind.dropFromPeak.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Hold — indica o que falta
  const dir = ind.rising ? `↑ ${ind.sma.toFixed(1)} (+${ind.riseFromTrough.toFixed(2)} desde vale)`
                         : `↓ ${ind.sma.toFixed(1)} (-${ind.dropFromPeak.toFixed(2)} desde pico)`;
  return {
    signal: 'hold',
    reason: `Hold: SMA(18)=${dir} · mín ${MIN_GAP}pts`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
