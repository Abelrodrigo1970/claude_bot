// RSI Reversal 29 (15m) — pedida pelo utilizador 28/09.
// Universo: top 30 perpétuos USDT por volume 24h (symbolSource 'topVolume').
//
// Entrada LONG (últimas duas velas 15m FECHADAS):
//   RSI(14) da vela anterior < 29 e RSI(14) da última vela >= 29
//   (sai da sobrevenda — ex: 28 → 31)
//
// Gestão:
//   SL 2% (runner, stopLossPct)
//   TP1 +4% fecha 50% (runner, takeProfitTiers)
//   TP2 +9% fecha o restante — sinal close_long da própria estratégia via
//   context.unrealizedPnlPct (os tiers do runner só fazem fechos parciais)
//
// Backtest 60d, top 30 por volume, $40/trade (strategy-lab-bot/rsi_bot.py,
// saídas em velas de 15m, SL primeiro se ambos na mesma vela):
//   624 trades · WR 40,5% · PF 1,39 · PnL +122 USD · maxDD -47 USD
const { RSI } = require('technicalindicators');

const STRATEGY_NAME = 'RsiReversal29';

const RSI_PERIOD = 14;
const RSI_LEVEL = 29;
const TAKE_PROFIT_FULL_PCT = 0.09;

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

  const ind = { rsi, prevRsi, price: closes[closes.length - 1] };

  if (currentPosition === 'long') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= TAKE_PROFIT_FULL_PCT) {
      return {
        signal: 'close_long',
        reason: `TP2 — lucro +${(pnlPct * 100).toFixed(1)}% ≥ ${(TAKE_PROFIT_FULL_PCT * 100).toFixed(0)}% — fecha o restante`,
        indicators: ind,
      };
    }
    return {
      signal: 'hold',
      reason: `Mantém long — RSI ${rsi.toFixed(1)} · TP1 +4% (50%) · TP2 +9% · SL 2%`,
      indicators: ind,
    };
  }

  if (prevRsi < RSI_LEVEL && rsi >= RSI_LEVEL) {
    return {
      signal: 'long',
      reason: `RSI(14) ${prevRsi.toFixed(1)} → ${rsi.toFixed(1)} — saiu da sobrevenda (${RSI_LEVEL})`,
      indicators: ind,
    };
  }

  const reason = rsi < RSI_LEVEL
    ? `RSI ${rsi.toFixed(1)} em sobrevenda — à espera de fechar ≥ ${RSI_LEVEL}`
    : `RSI ${prevRsi.toFixed(1)} → ${rsi.toFixed(1)} sem cruzamento de ${RSI_LEVEL}`;
  return { signal: 'hold', reason, indicators: ind };
}

module.exports = { STRATEGY_NAME, RSI_LEVEL, generateSignal };
