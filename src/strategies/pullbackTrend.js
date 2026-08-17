// Pullback em Tendência: entra a favor da tendência (EMA21>EMA50) só depois
// de um recuo até perto da EMA21 seguido de retoma — em vez de perseguir o
// movimento (como a TrendSurfer, que entra no cruzamento EMA12/30), esta
// espera o preço "respirar" e confirma a retoma com RSI a virar para cima e
// uma vela de fecho de volta acima da EMA21. Pensada para correr sobre um
// universo já filtrado por tendência (scanner EMA Trend / EMA Trend Stocks —
// preço > EMA21 e EMA50, diário e 1h) — aqui só se decide o timing de entrada
// dentro desse universo.
const { EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'PullbackTrend';

const EMA_FAST    = 21;
const EMA_SLOW    = 50;
const RSI_PERIOD  = 14;
const LOOKBACK    = 6;    // janela (velas) onde se procura o recuo até à EMA21
const PULLBACK_TOLERANCE_PCT = 0.3; // low tem de chegar a <=0.3% acima da EMA21 (ou tocá-la) para contar como pullback
const RSI_DIP_MAX   = 55; // RSI tem de ter recuado para <=55 durante a janela (perde força, sem ser reversão)
const RSI_RECOVER_MIN = 45; // RSI atual tem de já estar a recuperar, >=45
const EXIT_RSI_MAX  = 40; // saída se RSI cair abaixo disto com tendência já quebrada

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const lows   = candles.map(c => c.low ?? c.close);

  const emaFastArr = EMA.calculate({ period: EMA_FAST, values: closes });
  const emaSlowArr = EMA.calculate({ period: EMA_SLOW, values: closes });
  const rsiArr     = RSI.calculate({ period: RSI_PERIOD, values: closes });

  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const rsi     = rsiArr[rsiArr.length - 1];
  const rsiPrev = rsiArr[rsiArr.length - 2];
  const price   = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  const uptrend   = emaFast > emaSlow;
  const downtrend = emaFast < emaSlow;
  const aboveSlow = price > emaSlow; // tendência ainda não quebrou (não perde o EMA50)

  // Pullback: nas últimas LOOKBACK velas (excluindo a atual), o preço chegou
  // perto da EMA21 (ou tocou-a por baixo) sem fechar abaixo da EMA50.
  const emaFastWindow = emaFastArr.slice(-(LOOKBACK + 1), -1);
  const lowWindow     = lows.slice(-(LOOKBACK + 1), -1);
  const closeWindow   = closes.slice(-(LOOKBACK + 1), -1);
  let pulledBack = false;
  for (let i = 0; i < emaFastWindow.length; i++) {
    const ef = emaFastWindow[i];
    if (ef == null) continue;
    const distPct = ((lowWindow[i] - ef) / ef) * 100;
    if (distPct <= PULLBACK_TOLERANCE_PCT) { pulledBack = true; break; }
  }

  const rsiWindow = rsiArr.slice(-(LOOKBACK + 1), -1);
  const rsiDipped = rsiWindow.some(v => v != null && v <= RSI_DIP_MAX);
  const rsiRecovering = rsi != null && rsiPrev != null && rsi > rsiPrev && rsi >= RSI_RECOVER_MIN;

  const bullishClose = price > prevClose && price > emaFast; // fecho de retoma, de volta acima da EMA21

  const validLong = uptrend && aboveSlow && pulledBack && rsiDipped && rsiRecovering && bullishClose;

  return {
    emaFast, emaSlow, rsi, price,
    uptrend, downtrend, aboveSlow,
    pulledBack, rsiDipped, rsiRecovering, bullishClose,
    validLong,
  };
}

function generateSignal(candles, currentPosition = null) {
  const minCandles = EMA_SLOW + RSI_PERIOD + LOOKBACK + 5;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);

  if (!currentPosition && ind.validLong) {
    return {
      signal: 'long',
      reason: `Pullback à EMA${EMA_FAST}(${ind.emaFast.toFixed(4)}) em tendência (EMA${EMA_SLOW}=${ind.emaSlow.toFixed(4)}) · RSI recuperou p/ ${ind.rsi.toFixed(1)} · retoma confirmada`,
      indicators: ind,
    };
  }

  // Saída: tendência quebra (preço perde a EMA50) ou RSI cai forte sem a tendência intacta
  if (currentPosition === 'long' && (!ind.aboveSlow || (ind.downtrend && ind.rsi < EXIT_RSI_MAX))) {
    return {
      signal: 'close_long',
      reason: !ind.aboveSlow
        ? `Preço perdeu a EMA${EMA_SLOW}(${ind.emaSlow.toFixed(4)}) — tendência quebrada`
        : `Tendência invertida (EMA${EMA_FAST}<EMA${EMA_SLOW}) + RSI=${ind.rsi.toFixed(1)}<${EXIT_RSI_MAX}`,
      indicators: ind,
    };
  }

  const missing = [];
  if (!ind.uptrend) missing.push('sem tendência de alta (EMA21<EMA50)');
  else {
    if (!ind.pulledBack)    missing.push('sem recuo recente à EMA21');
    if (!ind.rsiDipped)     missing.push(`RSI sem recuo (min. ${LOOKBACK} velas <=${RSI_DIP_MAX})`);
    if (!ind.rsiRecovering) missing.push(`RSI=${ind.rsi?.toFixed(1)} ainda não recupera (>=${RSI_RECOVER_MIN})`);
    if (!ind.bullishClose)  missing.push('sem vela de retoma acima da EMA21');
  }

  return {
    signal: 'hold',
    reason: `Hold: EMA${EMA_FAST}=${ind.emaFast?.toFixed(4)} ${ind.uptrend ? '>' : '<'} EMA${EMA_SLOW}=${ind.emaSlow?.toFixed(4)} · ${missing.join(' · ')}`,
    indicators: ind,
  };
}

module.exports = { generateSignal, calculateIndicators, STRATEGY_NAME };
