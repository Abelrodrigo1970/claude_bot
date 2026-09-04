// Pedida pelo utilizador (03/09), para estudo sobre o universo do scanner
// EMA90 (mesmo usado por TrendSurfer/EMA90TopFade — símbolos com close >
// EMA90 diária), em velas de 4h. Versão final (03/09) depois de 3 rondas de
// estudo — ver src/backtests/backtest-ema50BandCrossScaleOut*.js:
//   v1 (saída <EMA90): PF 1.21, PnL +604.92, maxDD -636.47 (90 dias)
//   v2 (saída <2% da EMA50, RSI87): PF 1.27, PnL +670.54 — melhor que v1
//   v2 + filtro vela de entrada <=20%: PF 1.31, PnL +719.50
//   v2 + filtro BTC>EMA50 na entrada: PF 1.38, PnL +619.58 (795->583 trades,
//     maxDD -739.07->-558.46) — a alavanca que mais reduziu o drawdown sem
//     sacrificar retorno. Esta versão combina os 3 ajustes.
//
// Entrada LONG (qualquer uma das duas condições de preço, E as três outras):
//   1) Preço acima da EMA50 mas a menos de 3% dela (banda de entrada), OU
//   2) Preço estava abaixo da EMA50 e acabou de cruzar para cima.
//   E a vela de entrada não teve um movimento (open->close) > 20% — evita
//   comprar no meio de um pump vertical/vela de exaustão.
//   E o BTC está também acima da sua própria EMA50 de 4h (context.btcBullish,
//   calculado no runner.js — ver getBtcBullish) — só bloqueia se soubermos
//   ao certo que o BTC está em baixa; sem dados (context.btcBullish
//   undefined, ex: chamadas de estudo sem context) não bloqueia.
//   E o símbolo está no top 30 do ranking do scanner EMA90 (context.rank,
//   1-indexed, calculado no runner.js — pedido do utilizador, 04/09, ver
//   study-ema50BandCrossScaleOut-scanner-rank.js: cortar no top 30 reduz o
//   drawdown ~5x — -631 -> -114 em 80 dias — sem piorar o profit factor).
//   Só se aplica quando o runner passa 'rank' no context; chamadas sem
//   ranking nenhum (ex: testes unitários sem context) não bloqueiam. Um
//   símbolo fora do top 50 do scan chega aqui com rank null -> bloqueado.
//
// Saída (gestão de posição de SL/TP fica em src/services/runner.js —
// stopLossPct + takeProfitTiers; este módulo só decide entrada e as duas
// saídas por sinal que dependem de indicadores, não de % fixa):
//   - SL fixo 10% (runner.js)
//   - OU preço cai 2% abaixo da EMA50 — tendência local invalidada.
//   - OU RSI(14) > 87 — exaustão/sobrecompra, fecha o que restar.
//   - TP1: +28% fecha 30% da posição (runner.js takeProfitTiers[0])
//   - TP2: +48% fecha mais 30% (runner.js takeProfitTiers[1])
//
// Nunca corrida nem testada ao vivo — arranca só em estudo (enabled:false).
const { EMA, RSI } = require('technicalindicators');

const STRATEGY_NAME = 'Ema50BandCrossScaleOut';

const EMA_PERIOD = 50;
const RSI_PERIOD = 14;
const BAND_MAX_PCT = 3;          // banda de entrada: até 3% acima da EMA50
const EXIT_BAND_PCT = 2;         // saída: 2% abaixo da EMA50
const RSI_EXIT_MAX = 87;
const ENTRY_CANDLE_MAX_MOVE_PCT = 20; // ignora entradas em velas com |open->close| > 20%
const SCANNER_TOP_N = 30;        // só entra se o rank no scanner EMA90 for <= 30

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const emaArr = EMA.calculate({ period: EMA_PERIOD, values: closes });
  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });

  const bar        = candles[candles.length - 1];
  const price      = closes[closes.length - 1];
  const prevClose  = closes[closes.length - 2];
  const ema50      = emaArr[emaArr.length - 1];
  const prevEma50  = emaArr[emaArr.length - 2];
  const rsi        = rsiArr[rsiArr.length - 1];

  const distPct50      = ema50 != null ? ((price - ema50) / ema50) * 100 : null;
  const aboveNearEma50  = distPct50 != null && distPct50 > 0 && distPct50 < BAND_MAX_PCT;
  const crossUpEma50    = prevClose != null && prevEma50 != null && ema50 != null
    && prevClose <= prevEma50 && price > ema50;

  const entryCandleMovePct = bar.open > 0 ? Math.abs((bar.close - bar.open) / bar.open) * 100 : 0;
  const entryCandleOk      = entryCandleMovePct <= ENTRY_CANDLE_MAX_MOVE_PCT;

  const belowEma50Exit = ema50 != null && price < ema50 * (1 - EXIT_BAND_PCT / 100);
  const rsiOverbought  = rsi != null && rsi > RSI_EXIT_MAX;

  const priceSignalOk = aboveNearEma50 || crossUpEma50;

  return {
    price, ema50, rsi, distPct50, entryCandleMovePct,
    aboveNearEma50, crossUpEma50, entryCandleOk, priceSignalOk,
    belowEma50Exit, rsiOverbought,
  };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  const minCandles = EMA_PERIOD + RSI_PERIOD + 10;
  if (candles.length < minCandles) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minCandles})`, indicators: {} };
  }

  const ind = calculateIndicators(candles);
  // Só bloqueia se soubermos mesmo que o BTC está em baixa — sem dados
  // (undefined, ex: chamadas sem context) não trava a entrada.
  const btcOk = context.btcBullish !== false;
  // Filtro de ranking do scanner EMA90 (top 30). Só se aplica quando o runner
  // passa 'rank' no context — chamadas sem ranking nenhum não bloqueiam.
  // rank null (símbolo fora do top 50 do scan) => fora do top 30 => bloqueado.
  const rank = context.rank ?? null;
  const rankOk = !('rank' in context) || (rank != null && rank <= SCANNER_TOP_N);
  const validEntry = ind.priceSignalOk && ind.entryCandleOk && btcOk && rankOk;

  if (!currentPosition) {
    if (validEntry) {
      const why = ind.crossUpEma50 ? 'cruzou para cima da EMA50' : `${ind.distPct50.toFixed(2)}% acima da EMA50 (banda <${BAND_MAX_PCT}%)`;
      const rankNote = rank != null ? ` — top ${SCANNER_TOP_N} do scanner (rank ${rank})` : '';
      return {
        signal: 'long',
        reason: `Preço ${ind.price.toFixed(6)} — ${why}${rankNote} — entra long`,
        indicators: ind,
      };
    }
    const missing = [];
    if (!ind.priceSignalOk) missing.push(`fora da banda de entrada (${ind.distPct50 != null ? ind.distPct50.toFixed(2) : '?'}%)`);
    if (!ind.entryCandleOk) missing.push(`vela de entrada com ${ind.entryCandleMovePct.toFixed(1)}% de movimento (>${ENTRY_CANDLE_MAX_MOVE_PCT}%)`);
    if (!btcOk) missing.push('BTC em baixa (abaixo da própria EMA50)');
    if (!rankOk) missing.push(`fora do top ${SCANNER_TOP_N} do scanner EMA90 (rank ${rank ?? 'fora do top 50'})`);
    return {
      signal: 'hold',
      reason: `Sem entrada — ${missing.join(' · ')}`,
      indicators: ind,
    };
  }

  if (currentPosition === 'long' && (ind.belowEma50Exit || ind.rsiOverbought)) {
    const reason = ind.belowEma50Exit
      ? `Preço (${ind.price.toFixed(6)}) caiu ${EXIT_BAND_PCT}%+ abaixo da EMA${EMA_PERIOD}(${ind.ema50.toFixed(6)}) — tendência invalidada`
      : `RSI(${RSI_PERIOD})=${ind.rsi.toFixed(1)} > ${RSI_EXIT_MAX} — exaustão, fecha o resto`;
    return { signal: 'close_long', reason, indicators: ind };
  }

  return {
    signal: 'hold',
    reason: `Mantém long — preço ${ind.price.toFixed(6)} · EMA${EMA_PERIOD}=${ind.ema50?.toFixed(6)} · RSI=${ind.rsi?.toFixed(1)}`,
    indicators: ind,
  };
}

module.exports = {
  STRATEGY_NAME, EMA_PERIOD, RSI_PERIOD, BAND_MAX_PCT, EXIT_BAND_PCT, RSI_EXIT_MAX, ENTRY_CANDLE_MAX_MOVE_PCT, SCANNER_TOP_N,
  generateSignal, calculateIndicators,
};
