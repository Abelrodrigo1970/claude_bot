const { RSI, SMA } = require('technicalindicators');

const STRATEGY_NAME = 'StockSMA';
const RSI_PERIOD    = 14;
const SMA_PERIOD    = 18;
const MIN_GAP       = 0.8;  // pontos mínimos acumulados desde o pico
const LOOKBACK      = 10;   // janela para encontrar pico recente
const RECENT_WINDOW = 3;    // pico deve estar nas últimas N velas da janela (evita re-trigger)
const RSI_SHORT_MAX = 60;   // SHORT so quando RSI nao esta ja muito oversold
const RSI_LONG_MIN  = 40;   // LONG so quando RSI nao esta ja muito overbought (espelho do RSI_SHORT_MAX)

function calculateIndicators(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const smaArr = SMA.calculate({ period: SMA_PERIOD, values: rsiArr });

  const sma0 = smaArr[smaArr.length - 1];
  const sma1 = smaArr[smaArr.length - 2];

  const rising  = sma0 > sma1;
  const falling = sma0 < sma1;

  const window = smaArr.slice(-(LOOKBACK + 1), -1);
  const localPeak   = Math.max(...window);
  const localTrough = Math.min(...window);

  // Indice mais recente onde a SMA estava no pico/vale
  let peakIdx = 0;
  let troughIdx = 0;
  for (let i = 0; i < window.length; i++) {
    if (window[i] >= localPeak) peakIdx = i;
    if (window[i] <= localTrough) troughIdx = i;
  }
  // Pico/vale recente: ocorreu nas ultimas RECENT_WINDOW velas da janela
  const peakIsRecent   = peakIdx >= LOOKBACK - RECENT_WINDOW;
  const troughIsRecent = troughIdx >= LOOKBACK - RECENT_WINDOW;

  const dropFromPeak   = localPeak - sma0;
  const riseFromTrough = sma0 - localTrough;

  const lastVolume = volumes[volumes.length - 1];
  const avgVolume  = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio   = avgVolume > 0 ? lastVolume / avgVolume : 0;
  const lastRsi    = rsiArr[rsiArr.length - 1];

  // SHORT valido: queda >= MIN_GAP + ainda a cair + pico recente + RSI nao oversold
  const validShort = dropFromPeak >= MIN_GAP && falling && peakIsRecent && lastRsi <= RSI_SHORT_MAX;
  // LONG valido: subida >= MIN_GAP + ainda a subir + vale recente + RSI nao overbought
  const validLong  = riseFromTrough >= MIN_GAP && rising && troughIsRecent && lastRsi >= RSI_LONG_MIN;

  return {
    rsi: lastRsi,
    sma: sma0,
    localPeak,
    localTrough,
    dropFromPeak,
    riseFromTrough,
    rising,
    falling,
    peakIsRecent,
    troughIsRecent,
    validShort,
    validLong,
    volRatio,
    price: closes[closes.length - 1],
  };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < RSI_PERIOD + SMA_PERIOD + LOOKBACK + 3) {
    return { signal: 'none', reason: 'Candles insuficientes', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  // Saida de long - SMA a cair 0.8 desde o pico. Se a queda ja e forte o
  // suficiente para valer como entrada short (validShort), inverte direto:
  // fecha o long e abre o short na mesma chamada, em vez de ficar flat 1 vela.
  if (currentPosition === 'long' && ind.falling && ind.dropFromPeak >= MIN_GAP) {
    if (ind.validShort) {
      return {
        signal: 'flip_to_short',
        reason: `SMA(18) inverteu pico=${ind.localPeak.toFixed(1)}->${ind.sma.toFixed(1)} (-${ind.dropFromPeak.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)} — fecha long, abre short`,
        indicators: ind,
      };
    }
    return {
      signal: 'close_long',
      reason: `SMA(18) pico=${ind.localPeak.toFixed(1)} atual=${ind.sma.toFixed(1)} (-${ind.dropFromPeak.toFixed(1)}pts)`,
      indicators: ind,
    };
  }

  // Saida de short - SMA a subir 0.8 desde o vale. Mesma logica de inversao
  // direta quando a subida ja vale como entrada long (validLong).
  if (currentPosition === 'short' && ind.rising && ind.riseFromTrough >= MIN_GAP) {
    if (ind.validLong) {
      return {
        signal: 'flip_to_long',
        reason: `SMA(18) inverteu vale=${ind.localTrough.toFixed(1)}->${ind.sma.toFixed(1)} (+${ind.riseFromTrough.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)} — fecha short, abre long`,
        indicators: ind,
      };
    }
    return {
      signal: 'close_short',
      reason: `SMA(18) vale=${ind.localTrough.toFixed(1)} atual=${ind.sma.toFixed(1)} (+${ind.riseFromTrough.toFixed(1)}pts)`,
      indicators: ind,
    };
  }

  // Entrada SHORT
  if (!currentPosition && ind.validShort) {
    return {
      signal: 'short',
      reason: `SMA(18) pico=${ind.localPeak.toFixed(1)}->${ind.sma.toFixed(1)} (-${ind.dropFromPeak.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Entrada LONG (espelho do short)
  if (!currentPosition && ind.validLong) {
    return {
      signal: 'long',
      reason: `SMA(18) vale=${ind.localTrough.toFixed(1)}->${ind.sma.toFixed(1)} (+${ind.riseFromTrough.toFixed(1)}pts) · RSI=${ind.rsi.toFixed(1)}`,
      indicators: ind,
    };
  }

  // Hold - diagnostico (conforme a direção atual da SMA)
  const missing = [];
  if (ind.falling) {
    if (ind.dropFromPeak < MIN_GAP)  missing.push(`queda=${ind.dropFromPeak.toFixed(2)}<${MIN_GAP}`);
    if (!ind.peakIsRecent)           missing.push('pico antigo (repetição bloqueada)');
    if (ind.rsi > RSI_SHORT_MAX)     missing.push(`RSI=${ind.rsi.toFixed(1)}>${RSI_SHORT_MAX}`);
  } else {
    if (ind.riseFromTrough < MIN_GAP) missing.push(`subida=${ind.riseFromTrough.toFixed(2)}<${MIN_GAP}`);
    if (!ind.troughIsRecent)          missing.push('vale antigo (repetição bloqueada)');
    if (ind.rsi < RSI_LONG_MIN)       missing.push(`RSI=${ind.rsi.toFixed(1)}<${RSI_LONG_MIN}`);
  }

  return {
    signal: 'hold',
    reason: `Hold: SMA(18)=${ind.sma.toFixed(1)} · ${missing.join(' · ') || 'sem condicoes'}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
