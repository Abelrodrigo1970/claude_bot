const STRATEGY_NAME = 'CandleBreakoutShort';

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
// como no Short (PF 0.38), enquanto a sessão asiática (00h-08h UTC) teve PF 1.20.
// Não bloqueia saídas — uma posição já aberta continua a poder fechar a qualquer hora.
function isBlockedHour(candles) {
  const hourUTC = candles[candles.length - 1].time.getUTCHours();
  return hourUTC >= 8 && hourUTC < 14;
}

// SHORT quando a vela atual fecha abaixo das últimas 3 (inverso da CandleBreakoutLong).
// Fecha se a vela inverter para cima ou pelo stop-loss de 20% anexado à ordem na Bybit.
function generateSignal(candles, currentPosition = null) {
  if (candles.length < 5) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 5)', indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition) {
    if (ind.breakoutDown && isBlockedHour(candles)) {
      return { signal: 'hold', reason: 'Breakdown válido, mas sessão europeia (08h-14h UTC) bloqueada por estudo de horários', indicators: ind };
    }
    if (ind.breakoutDown) {
      return {
        signal: 'short',
        reason: `Vela atual (${ind.c0.toFixed(6)}) abaixo das últimas 3 (${ind.c1.toFixed(6)}, ${ind.c2.toFixed(6)}, ${ind.c3.toFixed(6)})`,
        indicators: ind,
      };
    }
    return { signal: 'hold', reason: 'Sem breakdown de 4 velas', indicators: ind };
  }

  if (currentPosition === 'short' && ind.breakoutUp) {
    return { signal: 'close_short', reason: 'Vela atual inverteu acima das últimas 3', indicators: ind };
  }

  return { signal: 'hold', reason: 'Short aberto — a aguardar reversão ou stop-loss (20%)', indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators, isBlockedHour };
