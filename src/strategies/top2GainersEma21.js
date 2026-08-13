const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'Top2GainersEma21Dip';
const TOP_N = 2;
const EMA_PERIOD = 21;

// Estudo 13/08: backtest sobre o scanner Top N ganhos 24h (histórico completo,
// 10/07-13/08, ~90 símbolos que passaram pelo top2). LONG quando o símbolo
// está no Top N do ranking de ganhos 24h e o preço fecha abaixo da EMA21 —
// aposta que o líder do dia vai recuperar depois de um recuo. Testado TopN=2
// vs TopN=4, SL 2/5/7/10%, TP 10/12/14/15/18/19/21%, timeframe 15m/1h/4h.
//
// TopN=4 fica sistematicamente abaixo do breakeven em todas as combinações
// (WR real < WR necessário para o RR) — só funciona restrito ao TopN=2.
// Melhor combinação encontrada: 15m / SL 5% / TP 14% → 201 trades no
// backtest, WR 32.3% (breakeven 26.3%), +1.14%/trade, soma +230%.
//
// Sem sinal de saída por ranking no backtest (só SL/TP) — o close_long por
// sair do TopN abaixo é só um backstop de limpeza (evita posição "presa" em
// memória depois de um TP total via takeProfitCloseFraction:1, ver
// runner.js), não fazia parte da lógica testada.
function generateSignal(candles, currentPosition = null, context = {}) {
  const rank = context.rank ?? null;
  const inTopN = rank != null && rank <= TOP_N;

  if (candles.length < EMA_PERIOD + 2) {
    return { signal: 'none', reason: 'Candles insuficientes', indicators: { rank } };
  }

  const closes = candles.map(c => c.close);
  const emaArr = EMA.calculate({ period: EMA_PERIOD, values: closes });
  const ema = emaArr[emaArr.length - 1];
  const price = closes[closes.length - 1];

  if (currentPosition === 'long') {
    if (!inTopN) {
      return {
        signal: 'close_long',
        reason: `Saiu do Top${TOP_N} ganhos 24h (rank ${rank ?? 'fora'}) — backstop de limpeza, SL/TP já geriam a posição`,
        indicators: { rank, ema, price },
      };
    }
    return {
      signal: 'hold',
      reason: `Mantém long — Top${TOP_N} (rank ${rank}) · SL/TP geridos pelo runner`,
      indicators: { rank, ema, price },
    };
  }

  if (inTopN && price < ema) {
    return {
      signal: 'long',
      reason: `Top${TOP_N} ganhos 24h (rank ${rank}) · preço ${price} fechou abaixo da EMA${EMA_PERIOD} (${ema.toFixed(6)})`,
      indicators: { rank, ema, price },
    };
  }

  return {
    signal: 'hold',
    reason: inTopN
      ? `Top${TOP_N} (rank ${rank}) mas preço acima da EMA${EMA_PERIOD}`
      : `Fora do Top${TOP_N} (rank ${rank ?? 'sem dados'})`,
    indicators: { rank, ema, price },
  };
}

module.exports = { STRATEGY_NAME, TOP_N, EMA_PERIOD, generateSignal };
