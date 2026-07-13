const STRATEGY_NAME = 'EMA90TopFade';
const TOP_N = 8;

// Estratégia "fade" testada no estudo do scanner EMA90 (top-8, sem SL — PF 3.98
// nos dados históricos, claramente melhor que qualquer stop-loss fixo testado
// até 20%, porque os ganhos grandes desta estratégia só aparecem se a posição
// tiver espaço para reverter). Precisa do rank atual do símbolo no scanner
// EMA90 (não olha para velas) — vem em context.rank, calculado no runner a
// partir do scanner_results (posição no array = rank).
//
// SHORT quando o símbolo entra no top 8 do ranking EMA90 (% acima da EMA90
// diária) — aposta que o pump já está esticado. LONG quando sai do top 8 —
// compra o recuo. Sem stop-loss de propósito: nos dados, qualquer SL entre
// 5% e 20% piorou o resultado.
function generateSignal(candles, currentPosition = null, context = {}) {
  const rank = context.rank ?? null;
  const inTopN = rank != null && rank <= TOP_N;

  if (!currentPosition) {
    if (inTopN) {
      return {
        signal: 'short',
        reason: `Entrou no top ${TOP_N} do ranking EMA90 (rank ${rank}) — vender o pump esticado`,
        indicators: { rank },
      };
    }
    return { signal: 'hold', reason: `Fora do top ${TOP_N} (rank ${rank ?? 'sem dados'})`, indicators: { rank } };
  }

  if (currentPosition === 'short' && !inTopN) {
    return {
      signal: 'flip_to_long',
      reason: `Saiu do top ${TOP_N} (rank ${rank ?? 'fora do top 50'}) — comprar o recuo`,
      indicators: { rank },
    };
  }

  if (currentPosition === 'long' && inTopN) {
    return {
      signal: 'flip_to_short',
      reason: `Reentrou no top ${TOP_N} (rank ${rank}) — vender outra vez`,
      indicators: { rank },
    };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — rank atual ${rank ?? 'sem dados'}`, indicators: { rank } };
}

module.exports = { STRATEGY_NAME, TOP_N, generateSignal };
