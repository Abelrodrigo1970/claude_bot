const { EMA } = require('technicalindicators');

const STRATEGY_NAME = 'PumpEmaSpread';

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const ema12Arr = EMA.calculate({ period: 12, values: closes });
  const ema21Arr = EMA.calculate({ period: 21, values: closes });

  const price      = closes[closes.length - 1];
  const ema12      = ema12Arr[ema12Arr.length - 1];
  const ema21      = ema21Arr[ema21Arr.length - 1];
  const prevEma12  = ema12Arr[ema12Arr.length - 2];
  const prevEma21  = ema21Arr[ema21Arr.length - 2];

  const diffPct     = Math.abs(ema12 - ema21) / ema21 * 100;
  const prevDiffPct = Math.abs(prevEma12 - prevEma21) / prevEma21 * 100;
  const distMa21    = Math.abs(price - ema21) / ema21 * 100;

  const bullish = ema12 > ema21;
  const bearish = ema12 < ema21;

  // Banda de spread obrigatória para ENTRAR — nem cruzamento acabado de
  // acontecer (diffPct <= 0.6%, sem separação para confirmar direção) nem já
  // esticado (diffPct >= 1.5%, tendência já pode estar exaurida).
  const spreadOk = diffPct > 0.6 && diffPct < 1.5;

  // Confirmação de reversão para SAIR — exige o mesmo mínimo de separação
  // (0.6%) mas sem teto: uma vez confirmada a troca de direção, sai mesmo
  // que o spread já vá longe. Sem isto, qualquer cruzamento de ruído (a
  // EMA12 toca a EMA21 por 0.01%) fecharia a posição — foi o que aconteceu
  // no primeiro backtest (494 trades, hold médio de 2-4h). Com esta
  // confirmação a posição aguenta pullbacks pequenos dentro da tendência.
  const reversalConfirmed = diffPct > 0.6;

  return {
    price, ema12, ema21, prevEma12, prevEma21,
    diffPct, prevDiffPct, distMa21,
    bullish, bearish, spreadOk, reversalConfirmed,
  };
}

// LONG quando EMA12>EMA21 e o spread está na banda 0.6-1.5%. SHORT no
// espelho (EMA12<EMA21). Fecha quando a direção inverte E já confirmada por
// mais de 0.6% de separação (não ao primeiro tick em que cruza) — sem SL/TP
// próprios, saída é só por sinal.
function generateSignal(candles, currentPosition = null) {
  if (candles.length < 25) {
    return { signal: 'none', reason: 'Candles insuficientes (mínimo 25)', indicators: {} };
  }

  const ind = calculateIndicators(candles);
  const base = `EMA12=${ind.ema12.toFixed(6)} ${ind.bullish ? '>' : '<'} EMA21=${ind.ema21.toFixed(6)} · spread=${ind.diffPct.toFixed(2)}% · distEMA21=${ind.distMa21.toFixed(2)}%`;

  if (!currentPosition) {
    if (ind.bullish && ind.spreadOk) {
      return { signal: 'long', reason: `${base} · banda OK (0.6-1.5%) — entra long`, indicators: ind };
    }
    if (ind.bearish && ind.spreadOk) {
      return { signal: 'short', reason: `${base} · banda OK (0.6-1.5%) — entra short`, indicators: ind };
    }
    return {
      signal: 'hold',
      reason: `${base} · ${ind.spreadOk ? 'sem entrada' : 'fora da banda de spread'}`,
      indicators: ind,
    };
  }

  if (currentPosition === 'long' && ind.bearish && ind.reversalConfirmed) {
    return { signal: 'close_long', reason: `${base} · reversão confirmada (>0.6%) — fecha long`, indicators: ind };
  }
  if (currentPosition === 'short' && ind.bullish && ind.reversalConfirmed) {
    return { signal: 'close_short', reason: `${base} · reversão confirmada (>0.6%) — fecha short`, indicators: ind };
  }

  return { signal: 'hold', reason: `${base} · mantém ${currentPosition}`, indicators: ind };
}

module.exports = { STRATEGY_NAME, generateSignal, calculateIndicators };
