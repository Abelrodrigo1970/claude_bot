const STRATEGY_NAME = 'CandleBreakoutLong';

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const c0 = closes[closes.length - 1];
  const c1 = closes[closes.length - 2];
  const c2 = closes[closes.length - 3];
  const c3 = closes[closes.length - 4];

  const breakoutUp   = c0 > c1 && c0 > c2 && c0 > c3;
  const breakoutDown = c0 < c1 && c0 < c2 && c0 < c3;

  return { c0, c1, c2, c3, breakoutUp, breakoutDown };
}

// LONG quando a vela atual fecha acima das últimas 3. Fecha se a vela inverter
// (fecha abaixo das últimas 3) ou pelo stop-loss de 5% anexado à ordem na Bybit.
function generateSignal(candles, currentPosition = null) {
  if (candles.length < 5) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 5)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.breakoutUp) {
      return {
        signal: 'long',
        reason: `Vela atual (${ind.c0.toFixed(6)}) acima das últimas 3 (${ind.c1.toFixed(6)}, ${ind.c2.toFixed(6)}, ${ind.c3.toFixed(6)})`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: 'Sem breakout de 4 velas', indicators: ind };
  }

  if (currentPosition === 'long' && ind.breakoutDown) {
    return { signal: 'close_long', reason: 'Vela atual inverteu abaixo das últimas 3', indicators: ind };
  }

  return { signal: 'hold', reason: 'Long aberto — a aguardar reversão ou stop-loss (20%)', indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
