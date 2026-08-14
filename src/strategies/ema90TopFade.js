const { RSI } = require('technicalindicators');

const STRATEGY_NAME = 'EMA90TopFade';
const TOP_N = 8;
const RSI_PERIOD = 14;
// Estudo 10/08 sobre os 158 shorts fechados até então: os 42 entrados com
// RSI(14) diário >= 72 somam -183.96 USDT; os outros 116 (RSI<72) somam
// +90.11 USDT — o quintil mais esticado carrega quase todo o prejuízo do
// lado short. Bloqueia só a entrada nova; não mexe no SL nem no lado long.
const RSI_SHORT_MAX = 72;

// Estratégia "fade" testada no estudo do scanner EMA90 (top-8, sem SL — PF 3.98
// nos dados históricos, claramente melhor que qualquer stop-loss fixo testado
// até 20%, porque os ganhos grandes desta estratégia só aparecem se a posição
// tiver espaço para reverter). Precisa do rank atual do símbolo no scanner
// EMA90 (não olha para velas para o ranking em si) — vem em context.rank,
// calculado no runner a partir do scanner_results (posição no array = rank).
//
// SHORT quando o símbolo entra no top 8 do ranking EMA90 (% acima da EMA90
// diária) — aposta que o pump já está esticado — mas só se o RSI(14) diário
// ainda não estiver extremo (< 72) e o QQQ (proxy do Nasdaq, ver context.qqqPositive,
// calculado no runner) não estiver a subir nesse dia. LONG quando sai do top 8 —
// compra o recuo. Sem stop-loss de propósito no desenho original: nos dados,
// qualquer SL entre 5% e 20% piorou o resultado (o SL de 26% em produção é
// decisão à parte, ver runner.js).
//
// Filtro QQQ adicionado em 14/08 — estudo dia-a-dia (01/07-14/08, 178 shorts):
// nos 20 dias em que o QQQ fechou em alta, o short somou -112.16 USDT; nos 25
// dias em que fechou em baixa, somou +19.41 USDT. O short desta estratégia só
// tem edge quando o mercado de ações está em queda — bloqueia só a entrada
// nova (e a reentrada via flip_to_short); não fecha shorts já abertos nem
// mexe no lado long.
function generateSignal(candles, currentPosition = null, context = {}) {
  const rank = context.rank ?? null;
  const inTopN = rank != null && rank <= TOP_N;
  const qqqBlocksShort = context.qqqPositive === true;

  const closes = candles.map(c => c.close);
  const rsiArr = RSI.calculate({ period: RSI_PERIOD, values: closes });
  const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1] : null;
  const rsiTooHot = rsi != null && rsi >= RSI_SHORT_MAX;
  const rsiLabel = rsi != null ? rsi.toFixed(1) : 'n/a';

  if (!currentPosition) {
    if (inTopN && qqqBlocksShort) {
      return {
        signal: 'hold',
        reason: `Top ${TOP_N} (rank ${rank}) mas QQQ está em alta hoje — short bloqueado (só tem edge com o Nasdaq a cair)`,
        indicators: { rank, rsi },
      };
    }
    if (inTopN && rsiTooHot) {
      return {
        signal: 'hold',
        reason: `Top ${TOP_N} (rank ${rank}) mas RSI(14)=${rsiLabel}>=${RSI_SHORT_MAX} — pump ainda a acelerar, não entra`,
        indicators: { rank, rsi },
      };
    }
    if (inTopN) {
      return {
        signal: 'short',
        reason: `Entrou no top ${TOP_N} do ranking EMA90 (rank ${rank}) · RSI(14)=${rsiLabel} — vender o pump esticado`,
        indicators: { rank, rsi },
      };
    }
    return { signal: 'hold', reason: `Fora do top ${TOP_N} (rank ${rank ?? 'sem dados'})`, indicators: { rank, rsi } };
  }

  if (currentPosition === 'short' && !inTopN) {
    return {
      signal: 'flip_to_long',
      reason: `Saiu do top ${TOP_N} (rank ${rank ?? 'fora do top 50'}) — comprar o recuo`,
      indicators: { rank, rsi },
    };
  }

  if (currentPosition === 'long' && inTopN) {
    if (qqqBlocksShort) {
      return {
        signal: 'hold',
        reason: `Reentrou no top ${TOP_N} (rank ${rank}) mas QQQ em alta — mantém long, não inverte para short`,
        indicators: { rank, rsi },
      };
    }
    if (rsiTooHot) {
      return {
        signal: 'hold',
        reason: `Reentrou no top ${TOP_N} (rank ${rank}) mas RSI(14)=${rsiLabel}>=${RSI_SHORT_MAX} — mantém long, não inverte`,
        indicators: { rank, rsi },
      };
    }
    return {
      signal: 'flip_to_short',
      reason: `Reentrou no top ${TOP_N} (rank ${rank}) · RSI(14)=${rsiLabel} — vender outra vez`,
      indicators: { rank, rsi },
    };
  }

  return { signal: 'hold', reason: `Mantém ${currentPosition} — rank atual ${rank ?? 'sem dados'}`, indicators: { rank, rsi } };
}

module.exports = { STRATEGY_NAME, TOP_N, RSI_SHORT_MAX, generateSignal };
