// WeekBB — Rumer's Box semanal · padrão b · LONG na reentrada (pedido do utilizador 14/10).
// Universo e caixa iguais aos da RumersBoxWeeklyB (symbolSource 'rumersWeeklyB',
// context.weeklyBox): caixa = máximo/mínimo da semana anterior, padrão b (queda > 6%
// nas 3 semanas antes da caixa), amplitude 1,5–14% (rumersBoxWeeklyB.isCandidate).
//
// Entrada LONG (últimas três velas 15m FECHADAS, todas na semana corrente):
//   vela A fecha ABAIXO do mínimo da caixa (o preço saiu por baixo)
//   + vela B volta a fechar DENTRO da caixa (reentrada)
//   + vela C (confirmação) fecha ACIMA do fecho da vela B — entra no fecho de C
//   + BTC acima da EMA50 da última vela diária fechada (context.btcAboveEma50Daily)
//   + 1 entrada por caixa e por par (enteredBoxes)
//
// Gestão (runner): SL 4% · TP +40% fecha tudo (sinal close_long) · fecho às 72h.
//
// Estudo 2025 e 2026 (motor rumers_p_reentry.extract com padrão b, velas 15m,
// SL antes de TP na mesma vela, $100/trade, taxas 0,055%/lado):
//   2025:      239 trades · WR 44% · PF 1,43 · +206 · DD 149
//   2026 (–out): 248 trades · WR 49% · PF 3,29 · +997 · DD 131 · máx ~40 abertas
// Sem a vela de confirmação 2025 dava PF 0,95. TP acima de 40% e fechos de 5–7
// dias foram piores. Arranca só em papel.
const rumersBoxWeeklyB = require('./rumersBoxWeeklyB');

const STRATEGY_NAME = 'WeekBB';

const TAKE_PROFIT_FULL_PCT = 0.40;
const BAR_MS = 15 * 60 * 1000;

// 'SYMBOL|periodKey' das caixas onde já houve entrada (recarregado da BD ao
// arrancar — ver loadRumersWeeklyBEntries em runner.js)
const enteredBoxes = new Set();

function markEntered(symbol, periodKey) { enteredBoxes.add(`${symbol}|${periodKey}`); }

function generateSignal(candles, currentPosition = null, context = {}) {
  const box = context.weeklyBox || null;
  const ind = { box, btcAboveEma50Daily: context.btcAboveEma50Daily ?? null };

  if (currentPosition === 'long') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= TAKE_PROFIT_FULL_PCT) {
      return { signal: 'close_long', reason: `TP +${(pnlPct * 100).toFixed(1)}% ≥ 40% — fecha tudo`, indicators: ind };
    }
    return { signal: 'hold', reason: 'Mantém long — TP +40% · SL 4% · fecho às 72h', indicators: ind };
  }

  if (!box) return { signal: 'none', reason: 'Sem caixa semanal (histórico curto)', indicators: ind };
  const now = Date.now();
  const closed = (candles || []).filter((c) => +c.time + BAR_MS <= now);
  if (closed.length < 3) return { signal: 'none', reason: 'Velas 15m insuficientes', indicators: ind };
  const [a, b, c] = closed.slice(-3);
  Object.assign(ind, { outClose: a.close, reentryClose: b.close, confirmClose: c.close });

  // as três velas têm de ser da semana em que esta caixa vale
  const sameWeek = [a, b, c].every((x) => rumersBoxWeeklyB.periodKeyOf(+x.time) === box.periodKey);
  const pattern = sameWeek && a.close < box.low && b.close >= box.low && b.close <= box.high && c.close > b.close;
  if (!pattern) {
    return { signal: 'hold', reason: `Sem saída por baixo + reentrada + confirmação na caixa ${box.low}–${box.high}`, indicators: ind };
  }
  const blocks = [];
  if (!rumersBoxWeeklyB.isCandidate(box)) blocks.push(`caixa ${box.rangePct.toFixed(1)}% · tendência ${box.trendPct.toFixed(1)}% fora do padrão b`);
  if (context.btcAboveEma50Daily !== true) blocks.push('BTC abaixo (ou sem dados) da EMA50 diária');
  if (enteredBoxes.has(`${context.symbol}|${box.periodKey}`)) blocks.push(`já entrou na caixa ${box.periodKey}`);
  if (blocks.length) return { signal: 'hold', reason: `Reentrada confirmada, mas ${blocks.join(' · ')}`, indicators: ind };

  if (context.symbol) markEntered(context.symbol, box.periodKey);
  return {
    signal: 'long',
    reason: `Reentrada na caixa da semana ${box.periodKey} (saiu a ${a.close}, voltou a ${b.close}, confirmou a ${c.close}) · padrão b ${box.trendPct.toFixed(1)}% · caixa ${box.rangePct.toFixed(1)}% · BTC > EMA50 1d`,
    indicators: ind,
  };
}

module.exports = { STRATEGY_NAME, generateSignal, markEntered };
