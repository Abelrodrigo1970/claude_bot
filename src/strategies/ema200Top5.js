const STRATEGY_NAME = 'EMA200Top5';
const TOP_N = 5;
const BLOCKED_DAYS = [0, 1]; // domingo, segunda (UTC)

// Estudo por dia da semana (25/06-01/08, 220 trades): Domingo e Segunda são
// os únicos dias negativos (WR 36-43%, PnL médio negativo nos dois cenários
// testados); Quinta é de longe o melhor (WR 53%, PnL médio +3.2 a +3.65).
// Bloqueia só entradas novas nesses dois dias — não bloqueia o fecho.
function isBlockedDay(candles) {
  const dow = candles[candles.length - 1]?.time?.getUTCDay();
  return BLOCKED_DAYS.includes(dow);
}

// Estudo (histórico completo até 01/08): LONG nos 5 primeiros do ranking
// EMA200, fecha tudo a cada sessão de scan nova e reabre o Top 5 atual —
// 220 trades, WR 50.9%, PF 1.30, PnL +29.94 (baseline). Com TP parcial 50%
// a +25% e SL a -25%: PF 1.41, PnL +34.71, drawdown -7.74 (vs -13.39 sem
// proteção) — melhor resultado testado, por isso os dois ficam configurados
// no registo da estratégia (takeProfitPct/stopLossPct), não aqui.
//
// Entra LONG assim que o símbolo entra no Top 5 do ranking EMA200 (rank vem
// em context.rank), exceto ao Domingo/Segunda (ver isBlockedDay). Uma vez
// posicionada, ignora o ranking dia a dia — só fecha (para o runner reabrir
// no próximo ciclo, se ainda estiver no Top 5) quando há uma sessão de scan
// nova (context.newScanSession), replicando o "fecha tudo e reabre" testado
// no estudo. TP e SL são geridos pelo runner.
function generateSignal(candles, currentPosition = null, context = {}) {
  const rank = context.rank ?? null;
  const inTopN = rank != null && rank <= TOP_N;

  if (!currentPosition) {
    if (inTopN && isBlockedDay(candles)) {
      return {
        signal: 'hold',
        reason: `Entraria no Top ${TOP_N} (rank ${rank}), mas Domingo/Segunda estão bloqueados (piores dias no estudo)`,
        indicators: { rank },
      };
    }
    if (inTopN) {
      return {
        signal: 'long',
        reason: `Entrou no Top ${TOP_N} do ranking EMA200 (rank ${rank})`,
        indicators: { rank },
      };
    }
    return { signal: 'hold', reason: `Fora do Top ${TOP_N} (rank ${rank ?? 'sem dados'})`, indicators: { rank } };
  }

  if (context.newScanSession) {
    return {
      signal: 'close_long',
      reason: `Nova sessão de scan EMA200 — fecha para reabrir o Top ${TOP_N} atual`,
      indicators: { rank },
    };
  }

  return { signal: 'hold', reason: `Mantém long — rank atual ${rank ?? 'sem dados'}`, indicators: { rank } };
}

module.exports = { STRATEGY_NAME, TOP_N, generateSignal, isBlockedDay };
