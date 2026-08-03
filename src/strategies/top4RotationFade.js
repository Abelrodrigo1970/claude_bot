const STRATEGY_NAME = 'Top4RotationFade';

// Universo: só símbolos que estavam no Top 4 de ganhos 24h no scan anterior e
// já não estão no scan atual (resolvido no runner via
// symbolSource='gainers24hDropped' — só chega aqui quem acabou de sair do
// Top 4, ver resolveSymbols). Não olha para velas nem indicadores, só para a
// saída do ranking entre duas sessões de scan consecutivas.
//
// Abre SHORT assim que um símbolo sai do Top 4 — aposta que o pump que o
// levou lá já esgotou e vai reverter. Sem TP (deixa correr até à saída
// natural). SL de 25% e hold máximo de ~4h são geridos genericamente pelo
// runner (strategy.stopLossPct / strategy.maxHoldHours) — ao fim do hold
// máximo fecha tudo; se o símbolo ainda estiver fora do Top 4 no ciclo
// seguinte, reabre.
function generateSignal(candles, currentPosition = null) {
  if (!currentPosition) {
    return {
      signal: 'short',
      reason: 'Saiu do Top 4 de ganhos 24h — vender a reversão',
      indicators: {},
    };
  }
  return {
    signal: 'hold',
    reason: 'Mantém short — aguarda SL (25%) ou hold máximo (~4h)',
    indicators: {},
  };
}

module.exports = { STRATEGY_NAME, generateSignal };
