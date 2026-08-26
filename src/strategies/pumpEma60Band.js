const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'PumpEma60Band';

// Versão final, validada por estudo (26/08, ver src/backtests/backtest-
// pumpEma60Band-live.js): LONG-ONLY. Entra quando o preço está entre 0% e
// 3% acima da EMA60 (banda de entrada — nem ainda por cima dela, nem já
// esticado). Sem sinal de saída próprio — a única saída é o SL fixo de 10%
// (ver strategy.stopLossPct em runner.js) ou continuar em aberto. Volta a
// entrar sempre que a banda 0-3% reaparecer depois de um SL.
//
// Percurso do estudo, todas em 15m sobre o universo Pump 24h, janela real
// desde que cada símbolo entrou no scanner (~19h de dados em 26/08):
//   long+short com flip (<-2% vira short): 84 trades, 44,0% acerto, +197,56
//   long-only (<-2% fecha e fica flat):     54 trades, 38,9% acerto, +214,60
//   long-only, só SL (sem saída por sinal): 46 trades, 43,5% acerto, +243,64  ← esta versão
// Cada simplificação melhorou o resultado — o gatilho de saída <-2% estava
// a fechar posições mesmo antes de reverterem (só 1 em 28 saídas por sinal
// deu lucro). Sem TP parcial: testado a vários níveis (15-100%, fecha 50%
// da posição), piorou sempre o resultado — o retorno depende muito de
// poucos trades grandes (BTR, TAC, ONG no estudo), e fechar metade cedo
// corta exatamente esses. Ainda assim, o resultado depende muito de poucos
// símbolos — não validado como robusto a longo prazo, só o melhor das
// variantes testadas até agora.
const LONG_BAND_MIN_PCT = 0;
const LONG_BAND_MAX_PCT = 3;

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const ema60Arr = EMA.calculate({ period: 60, values: closes });

  const price = closes[closes.length - 1];
  const ema60 = ema60Arr[ema60Arr.length - 1];
  const distPct = ((price - ema60) / ema60) * 100;

  const inLongBand = distPct > LONG_BAND_MIN_PCT && distPct < LONG_BAND_MAX_PCT;

  return { price, ema60, distPct, inLongBand };
}

function generateSignal(candles, currentPosition = null) {
  if (candles.length < 65) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 65)', indicators: {} };
  }

  const ind = calculateIndicators(candles);
  const base = `preço ${ind.distPct >= 0 ? '+' : ''}${ind.distPct.toFixed(2)}% vs EMA60=${ind.ema60.toFixed(6)}`;

  if (!currentPosition) {
    if (ind.inLongBand) {
      return { signal: 'long', reason: `${base} · dentro da banda 0-3% — entra long`, indicators: ind };
    }
    return { signal: 'hold', reason: `${base} · fora da banda de entrada`, indicators: ind };
  }

  // Long-only, sem sinal de saída — a posição só fecha pelo SL fixo
  // (ver runner.js) ou continua em aberto.
  return { signal: 'hold', reason: `${base} · mantém long (só sai por SL)`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
