// RSI Reversal 29 (15m) — pedida pelo utilizador 28/09.
// Universo: top 30 cripto por market cap sem stablecoins (lista fixa em runner.js).
//
// Entrada LONG (últimas duas velas 15m FECHADAS):
//   RSI(14) da vela anterior < 29 e RSI(14) da última vela >= 29
//   (sai da sobrevenda — ex: 28 → 31)
//   + BTC acima da EMA50 do 1h (context.btc1hAboveEma50 — ver getBtc1hAboveEma50
//     em runner.js; null = sem dados, bloqueia a entrada)
//
// Gestão:
//   SL 4% (runner, stopLossPct)
//   TP +15% fecha tudo — sinal close_long via context.unrealizedPnlPct
//
// Estudo 180d, top 30 market cap, $40/trade (strategy-lab-bot/rsi_sweep.py e
// rsi_filters.py, saídas em velas de 15m, SL primeiro se ambos na mesma vela):
//   regra original SL2 · TP1 4%(50%) · TP2 9%, sem filtro: 2022 trades, PF 1,04,
//     P&L +48, maxDD 228 — períodos de 60d: +31 / −110 / +128
//   esta versão (BTC 1h>EMA50 · SL4 · TP15): 428 trades, PF 1,62, P&L +299,
//     maxDD 110 — períodos de 60d: +85 / −23 / +238
const { RSI } = require('technicalindicators');

const STRATEGY_NAME = 'RsiReversal29';

const RSI_PERIOD = 14;
const RSI_LEVEL = 29;
const TAKE_PROFIT_FULL_PCT = 0.15;

function generateSignal(candles, currentPosition = null, context = {}) {
  const minRaw = RSI_PERIOD * 5;
  if (!candles || candles.length < minRaw) {
    return { signal: 'none', reason: `Candles insuficientes (mínimo ${minRaw})`, indicators: {} };
  }

  const closes = candles.slice(0, -1).map((c) => c.close); // exclui vela em formação
  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const rsi = rsiArr[rsiArr.length - 1];
  const prevRsi = rsiArr[rsiArr.length - 2];
  if (rsi == null || prevRsi == null) {
    return { signal: 'none', reason: 'RSI indisponível', indicators: {} };
  }

  const btcOk = context.btc1hAboveEma50 === true;
  const ind = { rsi, prevRsi, price: closes[closes.length - 1], btc1hAboveEma50: context.btc1hAboveEma50 ?? null };

  if (currentPosition === 'long') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= TAKE_PROFIT_FULL_PCT) {
      return {
        signal: 'close_long',
        reason: `TP — lucro +${(pnlPct * 100).toFixed(1)}% ≥ ${(TAKE_PROFIT_FULL_PCT * 100).toFixed(0)}% — fecha tudo`,
        indicators: ind,
      };
    }
    return {
      signal: 'hold',
      reason: `Mantém long — RSI ${rsi.toFixed(1)} · TP +15% · SL 4%`,
      indicators: ind,
    };
  }

  const crossed = prevRsi < RSI_LEVEL && rsi >= RSI_LEVEL;
  if (crossed && btcOk) {
    return {
      signal: 'long',
      reason: `RSI(14) ${prevRsi.toFixed(1)} → ${rsi.toFixed(1)} — saiu da sobrevenda (${RSI_LEVEL}) · BTC 1h > EMA50`,
      indicators: ind,
    };
  }

  let reason;
  if (crossed) reason = `RSI ${prevRsi.toFixed(1)} → ${rsi.toFixed(1)} cruzou ${RSI_LEVEL}, mas BTC abaixo (ou sem dados) da EMA50 1h`;
  else if (rsi < RSI_LEVEL) reason = `RSI ${rsi.toFixed(1)} em sobrevenda — à espera de fechar ≥ ${RSI_LEVEL}`;
  else reason = `RSI ${prevRsi.toFixed(1)} → ${rsi.toFixed(1)} sem cruzamento de ${RSI_LEVEL}`;
  return { signal: 'hold', reason, indicators: ind };
}

module.exports = { STRATEGY_NAME, RSI_LEVEL, generateSignal };
