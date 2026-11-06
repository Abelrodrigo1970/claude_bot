// Top 2 do scanner Pump 24h · SHORT na primeira vela 15m vermelha.
//
// Estudo 26 ago–3 nov 2026 (velas 15m Bybit, $100/trade, stop dentro da vela
// antes do alvo, comissões e funding real): top 2 · stop 15% · alvo 30% ·
// fecho às 48h deu +890, PF 1,25, drawdown 191, pior trade −22% (o funding
// soma-se ao stop). As regras antigas (top 3 · SL 40% · TP 50%) deram +682 com
// drawdown 432. 48h ganhou a 24h e 72h em todas as combinações; TP parcial
// 50/50, stop na entrada depois do parcial e filtro de funding renderam menos.
//
// Entrada: uma vez por scan e por símbolo, no fecho da primeira vela de 15m
// que abre depois do scan e fecha vermelha (fecho < abertura), com o par nas
// posições 1ª ou 2ª. Sem empilhar: o runner tem uma posição por símbolo.
// Saídas no runner: stopLossPct 0,15 · maxHoldHours 48. O alvo fecha tudo
// aqui, com close_short, quando o lucro não realizado chega a 30%.
const STRATEGY_NAME = 'PumpTop3RedShort';

const TOP_N = 2;
const TAKE_PROFIT_PCT = 0.30;
const BAR_MS = 15 * 60 * 1000;

// 'symbol|scannedAt' — uma entrada por scan. Vive em memória; um restart pode
// repetir a entrada do scan que estiver aberto se a posição já tiver fechado.
const enteredScans = new Set();

// 'enter' na primeira vela vermelha ainda por actuar, 'wait' se ainda não houve
// vermelha, 'missed' se essa vela já fechou numa volta anterior (não perseguir).
function entryDecision(candles, scannedAt, now = Date.now()) {
  const all = (candles || []).slice().sort((a, b) => +a.time - +b.time);
  const closedAfter = all.filter((c) => {
    const openMs = +c.time;
    return openMs >= scannedAt && openMs + BAR_MS <= now;
  });
  if (!closedAfter.length) return { kind: 'wait' };

  // Sem velas até ao scan não dá para saber se a primeira vermelha já passou.
  const oldest = all[0];
  if (!oldest || +oldest.time > scannedAt + BAR_MS) return { kind: 'missed' };

  const firstRed = closedAfter.find((c) => c.close < c.open);
  if (!firstRed) return { kind: 'wait' };
  const last = closedAfter[closedAfter.length - 1];
  if (+firstRed.time !== +last.time) return { kind: 'missed' };
  return { kind: 'enter', bar: firstRed };
}

function generateSignal(candles, currentPosition = null, context = {}) {
  const rank = context.rank ?? null;
  const scannedAt = context.scannedAt ?? null;
  const ind = { rank, scannedAt };

  if (currentPosition === 'short') {
    const pnlPct = context.unrealizedPnlPct;
    if (pnlPct != null && pnlPct >= TAKE_PROFIT_PCT) {
      return {
        signal: 'close_short',
        reason: `TP ${(pnlPct * 100).toFixed(1)}% ≥ 30% — fecha tudo`,
        indicators: { ...ind, pnlPct },
      };
    }
    return { signal: 'hold', reason: 'Mantém short — TP 30% · SL 15% · fecho às 48h', indicators: ind };
  }

  if (currentPosition) {
    return { signal: 'hold', reason: `Posição ${currentPosition} — esta estratégia só gere shorts`, indicators: ind };
  }

  if (rank == null || rank > TOP_N) {
    return { signal: 'hold', reason: `Fora do top ${TOP_N} (rank ${rank ?? 'sem dados'})`, indicators: ind };
  }
  if (scannedAt == null) {
    return { signal: 'none', reason: 'Scanner Pump 24h sem sessão', indicators: ind };
  }

  const scanKey = `${context.symbol}|${scannedAt}`;
  if (enteredScans.has(scanKey)) {
    return { signal: 'hold', reason: `Top ${rank} — já entrou neste scan`, indicators: ind };
  }

  const decision = entryDecision(candles, scannedAt);
  if (decision.kind === 'missed') {
    if (context.symbol) enteredScans.add(scanKey);
    return { signal: 'hold', reason: `Top ${rank} — a primeira vela vermelha deste scan já fechou`, indicators: ind };
  }
  if (decision.kind !== 'enter') {
    return { signal: 'hold', reason: `Top ${rank} — à espera da primeira vela 15m vermelha depois do scan`, indicators: ind };
  }

  const bar = decision.bar;
  if (context.symbol) enteredScans.add(scanKey);
  const drop = ((bar.open - bar.close) / bar.open) * 100;
  return {
    signal: 'short',
    reason: `Top ${rank} do Pump 24h · vela 15m vermelha ${drop.toFixed(2)}% · SL 15% · TP 30% ou 48h`,
    indicators: { ...ind, open: bar.open, close: bar.close },
  };
}

module.exports = { STRATEGY_NAME, TOP_N, TAKE_PROFIT_PCT, generateSignal };
