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

// Sessão europeia (08h-14h UTC) bloqueada para novas entradas — no estudo de
// horários (13/07), foi consistentemente a pior janela tanto no Long (PF 0.33)
// como no Short (PF 0.38), enquanto a sessão asiática (00h-08h UTC) teve PF 2.00.
// Não bloqueia saídas — uma posição já aberta continua a poder fechar a qualquer hora.
function isBlockedHour(candles) {
  const hourUTC = candles[candles.length - 1].time.getUTCHours();
  return hourUTC >= 8 && hourUTC < 14;
}

// LONG quando a vela atual fecha acima das últimas 3. Fecha se a vela inverter
// (fecha abaixo das últimas 3) ou pelo stop-loss de 20% anexado à ordem na Bybit.
function generateSignal(candles, currentPosition = null) {
  if (candles.length < 5) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 5)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.breakoutUp && isBlockedHour(candles)) {
      return { signal: 'hold', reason: 'Breakout válido, mas sessão europeia (08h-14h UTC) bloqueada por estudo de horários', indicators: ind };
    }
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

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators, isBlockedHour };
