const { RSI, SMA } = require('technicalindicators');

const STRATEGY_NAME = 'CandleBreakoutShort';
const RSI_PERIOD = 14;
const SMA_PERIOD = 18;
const RSI_ENTRY_THRESHOLD = 65;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const smaArr = SMA.calculate({ period: SMA_PERIOD, values: rsiArr });

  const lastRsi = rsiArr[rsiArr.length - 1];
  const prevRsi = rsiArr[rsiArr.length - 2];

  const sma0 = smaArr[smaArr.length - 1];
  const sma1 = smaArr[smaArr.length - 2];

  return {
    rsi: lastRsi,
    prevRsi,
    sma: sma0,
    prevSma: sma1,
    rising: sma0 > sma1,
    entrySignal: prevRsi > RSI_ENTRY_THRESHOLD,
  };
}

// Sessão europeia (08h-14h UTC) bloqueada para novas entradas — no estudo de
// horários (13/07), foi consistentemente a pior janela. Não bloqueia saídas.
function isBlockedHour(candles) {
  const hourUTC = candles[candles.length - 1].time.getUTCHours();
  return hourUTC >= 8 && hourUTC < 14;
}

// Entra SHORT quando o RSI(14) do candle anterior estava acima de 65
// (sobrecompra). Fecha quando a SMA(18) do próprio RSI vira para cima —
// sinal de que o momentum de queda já perdeu força — ou pelo stop-loss de 7%
// anexado à ordem na Bybit.
function generateSignal(candles, currentPosition = null) {
  const minCandles = RSI_PERIOD + SMA_PERIOD + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.entrySignal && isBlockedHour(candles)) {
      return {
        signal: 'hold',
        reason: `RSI anterior (${ind.prevRsi.toFixed(1)}) > ${RSI_ENTRY_THRESHOLD}, mas sessão europeia (08h-14h UTC) bloqueada`,
        indicators: ind,
      };
    }
    if (ind.entrySignal) {
      return {
        signal: 'short',
        reason: `RSI do candle anterior (${ind.prevRsi.toFixed(1)}) acima de ${RSI_ENTRY_THRESHOLD}`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: `RSI anterior (${ind.prevRsi.toFixed(1)}) não passou de ${RSI_ENTRY_THRESHOLD}`, indicators: ind };
  }

  if (currentPosition === 'short' && ind.rising) {
    return {
      signal: 'close_short',
      reason: `SMA(${SMA_PERIOD}) do RSI virou para cima: ${ind.prevSma.toFixed(1)} → ${ind.sma.toFixed(1)}`,
      indicators: ind,
    };
  }

  return { signal: 'hold', reason: `Short aberto — SMA(RSI) ainda a cair (${ind.sma.toFixed(1)})`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators, isBlockedHour };
