const pool = require('../db/pool');
const bybit = require('./bybit');
const { EMA } = require('technicalindicators');
const {
  getState: getScannerState, startScan, getGainersState, startScanGainers,
  getPumpState, startScanPump,
  getEmaTrendTotalState, startScanEmaTrendTotal,
} = require('./scanner');
const trendSurfer          = require('../strategies/trendSurfer');
const ema90TopFade         = require('../strategies/ema90TopFade');
const stoch50              = require('../strategies/stoch50');
const stockEma1270Cross    = require('../strategies/stockEma1270Cross');
const volumeSpike3xScaleOut = require('../strategies/volumeSpike3xScaleOut');
const ema50BandCrossScaleOut = require('../strategies/ema50BandCrossScaleOut');
const VOLATILE50_SYMBOLS   = require('../backtests/data/top50-6month-movers.json').movers.map(m => m.symbol);

// SL por lado (opt-in via stopLossLongPct/stopLossShortPct) — cai para
// stopLossPct quando o lado específico não está definido, para não mudar o
// comportamento das estratégias existentes (SL simétrico nos dois lados).
function stopLossPctFor(strategy, side) {
  if (side === 'long' && strategy.stopLossLongPct != null) return strategy.stopLossLongPct;
  if (side === 'short' && strategy.stopLossShortPct != null) return strategy.stopLossShortPct;
  return strategy.stopLossPct;
}

// Taxa taker da Bybit (USDT perpetuals, ordens market) — aplicada dos dois
// lados (entrada+saída) para que o PnL registado fique líquido de comissão.
const TAKER_FEE_RATE = 0.00055;

// Regime QQQ (proxy do Nasdaq) — opt-in via strategy.qqqShortFilter (ver
// EMA90TopFade). Compara o close da vela diária em curso (ainda a formar-se,
// como o resto do código já faz para ranks — ver scanner.js) com o close do
// dia anterior. Cache de 15min para não pedir isto à Bybit a cada símbolo.
let qqqRegimeCache = { positive: null, fetchedAt: 0 };
const QQQ_CACHE_TTL = 15 * 60 * 1000;

async function getQqqPositive() {
  if (Date.now() - qqqRegimeCache.fetchedAt < QQQ_CACHE_TTL) return qqqRegimeCache.positive;
  try {
    const candles = await bybit.getCandles('QQQ/USDT:USDT', '1d', 2);
    if (candles.length < 2) return qqqRegimeCache.positive;
    const prevClose = candles[candles.length - 2].close;
    const lastClose = candles[candles.length - 1].close;
    qqqRegimeCache = { positive: lastClose >= prevClose, fetchedAt: Date.now() };
  } catch (err) {
    console.warn(`[Runner] Falha ao obter regime QQQ: ${err.message}`);
  }
  return qqqRegimeCache.positive;
}

// Regime BTC — opt-in via strategy.btcTrendFilter (ver
// Ema50BandCrossScaleOut). Compara o preço de fecho de 4h com a própria
// EMA50 de 4h do BTC — mesma lógica de tendência que a estratégia aplica a
// cada símbolo, aplicada ao BTC como filtro de mercado (estudo 03/09: PF
// 1.26->1.38, maxDD -739->-558 ao bloquear entradas novas quando o BTC
// está em baixa). Cache de 15min — não vale a pena recalcular a cada símbolo.
let btcRegimeCache = { bullish: null, fetchedAt: 0 };
const BTC_REGIME_CACHE_TTL = 15 * 60 * 1000;

async function getBtcBullish() {
  if (Date.now() - btcRegimeCache.fetchedAt < BTC_REGIME_CACHE_TTL) return btcRegimeCache.bullish;
  try {
    const candles = await bybit.getCandles('BTC/USDT:USDT', '4h', 60);
    const closes = candles.map(c => c.close);
    const emaArr = EMA.calculate({ period: 50, values: closes });
    const ema50  = emaArr[emaArr.length - 1];
    const price  = closes[closes.length - 1];
    if (ema50 != null) btcRegimeCache = { bullish: price > ema50, fetchedAt: Date.now() };
  } catch (err) {
    console.warn(`[Runner] Falha ao obter regime BTC: ${err.message}`);
  }
  return btcRegimeCache.bullish;
}

// Registry de estratégias ativas
// market: 'crypto' | 'stock'
// symbolSource: 'scanner' (padrão) | 'stocks' (tabela stock_symbols)
const STRATEGIES = [
  {
    name: trendSurfer.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90,
    timeframe: '1h',
    generateSignal: trendSurfer.generateSignal,
    positionSize: 60,
    enabled: true,
  },
  {
    name: ema90TopFade.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90,
    // Diário (não 1h) — a estratégia é 100% rank-driven e não olhava para velas
    // até agora, mas o filtro de RSI(14) novo (ver ema90TopFade.js) precisa de
    // candles diárias para bater com o estudo que o validou.
    timeframe: '1d',
    generateSignal: ema90TopFade.generateSignal,
    positionSize: 60,
    stopLossPct: 0.26,
    // Backtest intracandle (139 trades fechados, 27/07) confirma que qualquer SL
    // piora o resultado agregado — a 26% ainda corta 5 trades que atingem essa
    // excursão contra a posição, 3 dos quais teriam recuperado para +8.7%/+11.3%/+18.7%
    // (total simulado +394% vs. +556% sem SL). Ligado mesmo assim agora que a
    // estratégia está com ordens reais — o SL aqui é para limitar a perda máxima
    // por posição, não para melhorar o retorno esperado.
    //
    // Filtro RSI(14)<72 nos shorts adicionado em 10/08 — estudo sobre os 158
    // shorts fechados até então: os 42 com RSI diário>=72 na entrada somam
    // -183.96 USDT; os outros 116 (RSI<72) somam +90.11 USDT. Ver ema90TopFade.js.
    //
    // Filtro QQQ adicionado em 14/08 — estudo dia-a-dia (01/07-14/08): o short
    // só ganha dinheiro quando o Nasdaq (QQQ) fecha em baixa (-112.16 USDT em
    // dias QQQ+ vs +19.41 em dias QQQ-). qqqShortFilter liga o cálculo do
    // regime QQQ no runner (context.qqqPositive) — ver getQqqPositive abaixo.
    qqqShortFilter: true,
    enabled: true,
  },
  {
    name: stoch50.STRATEGY_NAME,
    market: 'stock',
    symbol: null,
    // Lista fixa (whitelist) substituída em 03/09 — troca a abordagem
    // anterior (symbolSource:'stocks' + symbolExclude) por uma lista curada
    // das únicas 39 stocks lucrativas, validada em 3 amostras independentes:
    //   1) src/backtests/study-all-strategies-x-stocks.js (30 dias) — deu a
    //      lista original de 53 "mantidas", mas tinha um bug de contagem
    //      (buffer de warmup entrava nas estatísticas, inflava a janela
    //      real para ~40 dias sem avisar).
    //   2) src/backtests/validate-stoch50-filter-oos.js (30d IS recalculado
    //      + 30d OOS, 05/07-04/08, nunca visto pela lista) — 44/73 símbolos
    //      inverteram de sinal entre as duas janelas (lista instável ao
    //      nível individual), mas o GRUPO "mantidos" continuou a bater o
    //      "excluídos" na janela OOS (+0.243 vs +0.113 USDT/trade) — e daí
    //      saíram os subconjuntos consistentes nas duas janelas: 17
    //      consistentemente lucrativas, 12 consistentemente negativas.
    //   3) src/backtests/study-stoch50-60days.js (60 dias, sem o bug de
    //      contagem) — as 17 lucrativas e as 12 negativas da amostra (2)
    //      bateram 100% certo com a classificação desta janela maior e
    //      independente. As 39 stocks abaixo são as lucrativas desta
    //      janela de 60 dias (PnL/trade +0.305 vs -0.226 das 35 excluídas).
    // Ainda assim, é uma lista curada com base em backtest histórico, não
    // uma garantia de edge futuro — a reavaliar periodicamente.
    symbols: [
      'AAPL/USDT:USDT', 'ADBE/USDT:USDT', 'ALAB/USDT:USDT', 'AMZN/USDT:USDT', 'ARM/USDT:USDT',
      'AXTI/USDT:USDT', 'BABA/USDT:USDT', 'BMNR/USDT:USDT', 'CBRS/USDT:USDT', 'CIEN/USDT:USDT',
      'COHR/USDT:USDT', 'COIN/USDT:USDT', 'CRCL/USDT:USDT', 'CRDO/USDT:USDT', 'CRWV/USDT:USDT',
      'DELL/USDT:USDT', 'EWJ/USDT:USDT', 'EWT/USDT:USDT', 'EWY/USDT:USDT', 'GOOGL/USDT:USDT',
      'HPE/USDT:USDT', 'HYUNDAI/USDT:USDT', 'IREN/USDT:USDT', 'KORU/USDT:USDT', 'LITE/USDT:USDT',
      'LLY/USDT:USDT', 'LRCX/USDT:USDT', 'MRVL/USDT:USDT', 'MSFT/USDT:USDT', 'MU/USDT:USDT',
      'NBIS/USDT:USDT', 'NVDA/USDT:USDT', 'PLTR/USDT:USDT', 'QQQ/USDT:USDT', 'SMCI/USDT:USDT',
      'SNDK/USDT:USDT', 'SOXL/USDT:USDT', 'TQQQ/USDT:USDT', 'USAR/USDT:USDT',
    ],
    timeframe: '1h',
    generateSignal: stoch50.generateSignal,
    positionSize: 60,
    // Stochastic K(50)/suavização 40/%D 11 — cruzamento de %K sobre %D, sem
    // filtro. Backtest (74 símbolos, ~70 dias, sem TP): WR 36.9%, +305.71 USDT
    // vs. config antiga (K9/D9, filtro D>20): WR 31.5%, -709.59 USDT. Com TP
    // parcial 50% a +15% (ambos os lados): +448.89 USDT no mesmo backtest —
    // melhor das 3 variantes testadas (10/15/20%).
    //
    // Long-only desde 14/08 — estudo dia-a-dia (05-14/08, dados reais): o
    // short perdia em dias QQQ+ e QQQ- (-59.03 e -46.32 USDT), sem edge em
    // nenhum regime. Long-only teria dado +147.80 USDT no período vs. +42.44
    // real (long+short). generateSignal já não abre short — ver stoch50.js.
    // Ligada em 03/09 depois da lista de 39 símbolos acima ficar validada
    // em 3 amostras independentes (ver comentário junto a `symbols`).
    takeProfitPct: 0.15,
    takeProfitCloseFraction: 0.5,
    takeProfitSide: 'long',
    enabled: true,
  },
  {
    name: stockEma1270Cross.STRATEGY_NAME,
    market: 'stock',
    symbol: null,
    symbols: [
      'NBIS/USDT:USDT', 'AXTI/USDT:USDT', 'MRVL/USDT:USDT', 'COHR/USDT:USDT', 'ASTS/USDT:USDT',
      'AAOI/USDT:USDT', 'RKLB/USDT:USDT', 'HPE/USDT:USDT', 'USAR/USDT:USDT', 'SMCI/USDT:USDT',
      'GLW/USDT:USDT', 'GOOGL/USDT:USDT', 'MSFT/USDT:USDT', 'BABA/USDT:USDT', 'META/USDT:USDT',
    ],
    timeframe: '1h',
    generateSignal: stockEma1270Cross.generateSignal,
    positionSize: 60,
    takeProfitPct: 0.19,
    takeProfitCloseFraction: 0.5,
    // Cruzamento EMA12/EMA70 (1h), sempre no mercado — inverte de posição a
    // cada cruzamento, sem filtro (ver stockEma1270Cross.js). Lista de 15
    // símbolos curada a partir de um estudo sobre os 74 stocks/ETFs (ver
    // backtest-stockEma1270Cross.js, 48 dias): universo completo perdia
    // (-278.11 USDT, PF 0.83), mas estes 15 — todos individualmente
    // positivos — deram +234.52 USDT, PF 1.99 sem SL/TP.
    //
    // TP parcial 50% a 19% — sweep sobre o TOP15 (ver
    // backtest-stockEma1270Cross-top15-sltp.js e -top15-tp2.js): SL fixo
    // (2-12%) foi sempre pior que sem SL, por isso fica sem stopLossPct.
    // TP testado de 5% a 29% — pico em 18-20%, com 19% o melhor exato
    // (+264.15 USDT, PF 2.13, maxDD -29.22, WR 44.9%, vs. +236.91/PF1.99/
    // maxDD-40.44 sem TP). Diferença entre 18/19/20% é pequena (~1%),
    // qualquer um destes é uma escolha sólida.
    // Nunca corrida nem testada ao vivo — arranca só em estudo.
    enabled: false,
  },
  {
    name: volumeSpike3xScaleOut.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    symbols: VOLATILE50_SYMBOLS, // mesmo universo fixo do scanner Lista 50
    timeframe: '15m',
    generateSignal: volumeSpike3xScaleOut.generateSignal,
    positionSize: 60,
    stopLossPct: 0.04,
    // Pedida pelo utilizador (03/09): sobre o universo do scanner "Lista 50"
    // (top50-6month-movers.json), entra long quando o volume da vela de 15m
    // é >=3x a média das 10 anteriores (e a vela fecha em alta — confirmação
    // de direção, ver volumeSpike3xScaleOut.js). SL fixo 4%. Dois níveis de
    // take-profit parcial (ver takeProfitTiers no runner.js, cada fraction
    // fecha % do que resta nesse momento, não da entrada original): TP1 a
    // +8% fecha 30%, TP2 a +45% fecha mais 30% (~49% da entrada original
    // fica aberto depois dos dois). O que sobra sai quando o preço fecha
    // abaixo da EMA50 de 15m (sinal da própria estratégia).
    takeProfitTiers: [
      { pct: 0.08, fraction: 0.30 },
      { pct: 0.45, fraction: 0.30 },
    ],
    // Nunca corrida nem testada ao vivo — arranca só em estudo.
    enabled: false,
  },
  {
    name: ema50BandCrossScaleOut.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90, // universo do Scanner EMA90 (mesmo do TrendSurfer/EMA90TopFade)
    topN: ema50BandCrossScaleOut.SCANNER_TOP_N, // só os 30 primeiros do ranking (pedido do utilizador, 04/09)
    timeframe: '4h',
    generateSignal: ema50BandCrossScaleOut.generateSignal,
    positionSize: 60,
    stopLossPct: 0.10,
    btcTrendFilter: true, // ver getBtcBullish acima — só entra se o BTC também está acima da própria EMA50
    // Pedida pelo utilizador (03/09), sobre o universo do scanner EMA90, em
    // 4h. Entra long quando o preço está a menos de 3% acima da EMA50, OU
    // acabou de cruzar a EMA50 para cima, E a vela de entrada não teve
    // >20% de movimento, E o BTC está também em tendência de alta (ver
    // ema50BandCrossScaleOut.js). SL fixo 10%. Dois níveis de take-profit
    // parcial (runner.js takeProfitTiers): TP1 a +28% fecha 30%, TP2 a
    // +48% fecha mais 30% (~49% da entrada original fica aberto depois dos
    // dois). O que sobra sai quando o preço cai 2% abaixo da EMA50
    // (tendência invalidada) OU RSI(14) > 87 (exaustão).
    //
    // 04/09: filtro adicional — só entra se o símbolo estiver no top 30 do
    // ranking do scanner EMA90 (topN acima + guarda em generateSignal via
    // context.rank). Ver src/backtests/study-ema50BandCrossScaleOut-scanner-rank.js:
    // cortar no top 30 baixa o maxDD de ~-631 para ~-114 em 80 dias sem
    // piorar o profit factor (1.40 vs 1.44 sem filtro).
    //
    // Percurso do estudo (90 dias, universo EMA90 atual, ver
    // src/backtests/backtest-ema50BandCrossScaleOut*.js):
    //   v1 (saída <EMA90):                          PF 1.21, PnL +604.92, maxDD -636.47
    //   v2 (saída <2% EMA50):                        PF 1.27, PnL +670.54
    //   v2 + filtro vela entrada <=20%:               PF 1.31, PnL +719.50
    //   v2 + filtro BTC>EMA50 (esta versão):          PF 1.38, PnL +619.58, maxDD -558.46
    //     (795->583 trades — menos trades, mais lucro E menos drawdown)
    // Testámos também um limite de posições concorrentes (reduz drawdown
    // mas corta lucro na mesma proporção — pior troca que o filtro BTC) —
    // não incluído aqui, sem infraestrutura de limite por estratégia ainda.
    takeProfitTiers: [
      { pct: 0.28, fraction: 0.30 },
      { pct: 0.48, fraction: 0.30 },
    ],
    // Nunca corrida nem testada ao vivo — arranca só em estudo.
    enabled: false,
  },
];
// PumpEmaSpread, PumpTrendFlip, PumpEma60Band e StockSMA removidas em 03/09
// — as 4 estavam com PnL negativo desde 01/06 nos dados reais (ver estudo
// src/backtests/study-strategies-since.js 2026-06-01): PumpEma60Band
// -603.26 USDT (0% win rate), PumpTrendFlip -213.11, PumpEmaSpread -130.26,
// StockSMA -75.62. Os módulos (src/strategies/pumpEmaSpread.js,
// pumpTrendFlip.js, pumpEma60Band.js, stockSMA.js) continuam no repo, só
// saíram do registry — podem voltar se um estudo futuro mostrar edge.
//
// StockSMA estava enabled:true — tinha 8 posições reais abertas na Bybit no
// momento da remoção (SPCX, ASTS, HPE short, IWM, ORCL, USAR, QCOM, RKLB).
// Ficaram abertas sem gestão automática (pedido explícito do utilizador) —
// precisam de fecho manual quando for oportuno.

// Sinais em memória (fallback quando BD não está configurada)
const memorySignals = [];
const MAX_MEMORY_SIGNALS = 500;

function getMemorySignals() { return memorySignals; }

// Estado de execução em curso (para progresso na UI)
let runState = {
  running: false, phase: null, strategy: null, current: 0, total: 0,
  log: [],
  summary: null, // { finishedAt, analyzed, signals, holds, errors }
};

function getRunState() { return runState; }

async function saveSignal(strategyName, symbol, signalType, price, timeframe, indicators) {
  const signal = {
    id: Date.now() + Math.random(),
    strategy_name: strategyName,
    symbol,
    signal_type: signalType,
    price,
    timeframe,
    indicators,
    created_at: new Date().toISOString(),
  };

  // Guarda sempre em memória (sobrevive sem BD)
  memorySignals.unshift(signal);
  if (memorySignals.length > MAX_MEMORY_SIGNALS) memorySignals.pop();

  // Tenta persistir na BD
  try {
    await pool.query(
      `INSERT INTO signals (strategy_name, symbol, signal_type, price, timeframe, indicators)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [strategyName, symbol, signalType, price, timeframe, JSON.stringify(indicators)]
    );
  } catch { /* BD não configurada — sinal já está em memória */ }
}

async function openTrade(strategyName, symbol, side, entryPrice, quantity, metadata = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO trades (strategy_name, symbol, side, entry_price, quantity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [strategyName, symbol, side, entryPrice, quantity, JSON.stringify(metadata)]
    );
    return result.rows[0].id;
  } catch { return null; }
}

async function closeTrade(tradeId, exitPrice) {
  if (!tradeId) return;
  try {
    const { rows } = await pool.query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!rows.length) return;
    const trade = rows[0];
    const entryPrice = parseFloat(trade.entry_price);
    const qty = parseFloat(trade.quantity);
    const grossPnl = trade.side === 'long'
      ? (exitPrice - entryPrice) * qty
      : (entryPrice - exitPrice) * qty;
    const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE_RATE;
    const pnl = grossPnl - fee;
    const pnlPct = trade.side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    await pool.query(
      `UPDATE trades SET exit_price=$1, pnl=$2, pnl_pct=$3, fee=$4, status='closed', closed_at=NOW() WHERE id=$5`,
      [exitPrice, pnl, pnlPct, fee, tradeId]
    );
    await updateStats(trade.strategy_name, trade.symbol, pnl > 0);
  } catch { /* BD não configurada */ }
}

// Fecha só uma fração de um trade aberto: regista o lote fechado como um
// trade "filho" independente (mesma entrada, fecho agora) e reduz a
// quantidade do trade original, que continua aberto para o resto da posição.
async function partialCloseTrade(tradeId, exitPrice, closeFraction) {
  try {
    const { rows } = await pool.query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!rows.length) return null;
    const trade = rows[0];
    const fullQty = parseFloat(trade.quantity);
    const closeQty = fullQty * closeFraction;
    const remainingQty = fullQty - closeQty;
    const entryPrice = parseFloat(trade.entry_price);

    const grossPnl = trade.side === 'long'
      ? (exitPrice - entryPrice) * closeQty
      : (entryPrice - exitPrice) * closeQty;
    const fee = (entryPrice * closeQty + exitPrice * closeQty) * TAKER_FEE_RATE;
    const pnl = grossPnl - fee;
    const pnlPct = trade.side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

    await pool.query(
      `INSERT INTO trades (strategy_name, symbol, side, entry_price, exit_price, quantity, pnl, pnl_pct, fee, status, metadata, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'closed',$10,$11,NOW())`,
      [trade.strategy_name, trade.symbol, trade.side, trade.entry_price, exitPrice, closeQty, pnl, pnlPct, fee,
       JSON.stringify({ reason: 'take-profit parcial', parentTradeId: tradeId }), trade.opened_at]
    );
    await pool.query(`UPDATE trades SET quantity = $1 WHERE id = $2`, [remainingQty, tradeId]);
    await updateStats(trade.strategy_name, trade.symbol, pnl > 0);

    return { closeQty, remainingQty, pnl, pnlPct };
  } catch (err) {
    console.warn(`[TP parcial] Falha ao registar fecho parcial do trade ${tradeId}: ${err.message}`);
    return null;
  }
}

async function updateStats(strategyName, symbol, isWin) {
  try {
    await pool.query(
      `INSERT INTO strategy_stats (strategy_name, symbol, total_trades, winning_trades, total_pnl)
       VALUES ($1, $2, 1, $3, 0)
       ON CONFLICT (strategy_name, symbol)
       DO UPDATE SET
         total_trades    = strategy_stats.total_trades + 1,
         winning_trades  = strategy_stats.winning_trades + $3,
         win_rate        = (strategy_stats.winning_trades + $3)::decimal / (strategy_stats.total_trades + 1) * 100,
         updated_at      = NOW()`,
      [strategyName, symbol, isWin ? 1 : 0]
    );
  } catch { /* BD não configurada */ }
}

// Cache de símbolos de stocks (carregados da BD)
let stockSymbolsCache = [];

async function loadStockSymbols() {
  try {
    const { rows } = await pool.query(
      `SELECT symbol FROM stock_symbols WHERE active=true ORDER BY ticker`
    );
    stockSymbolsCache = rows.map(r => r.symbol);
    if (stockSymbolsCache.length) console.log(`[Runner] ${stockSymbolsCache.length} stock symbols carregados`);
  } catch { /* BD não disponível */ }
}

// Estado em memória das posições abertas: { 'TrendSurfer_BTC/USDT:USDT': { tradeId, side } }
const openPositions = {};

// Cooldown por sinal: evita re-sinalizar o mesmo crossover na mesma vela
// key: 'StrategyName_symbol_signalType', value: timestamp do último sinal
const signalCooldown = {};

function isOnCooldown(strategyName, symbol, signalType, timeframe) {
  const key = `${strategyName}_${symbol}_${signalType}`;
  const last = signalCooldown[key];
  if (!last) return false;
  const tfMs = { '5m': 5, '15m': 15, '1h': 60, '2h': 120, '4h': 240, '1d': 1440 }[timeframe] || 60;
  return (Date.now() - last) < tfMs * 60 * 1000;
}

function setCooldown(strategyName, symbol, signalType) {
  signalCooldown[`${strategyName}_${symbol}_${signalType}`] = Date.now();
}

// Contadores do run atual
let _counts = { signals: 0, holds: 0, errors: 0 };

async function runStrategyOnSymbol(strategy, symbol) {
  const key = `${strategy.name}_${symbol}`;
  try {
    const candles = await bybit.getCandles(symbol, strategy.timeframe, 250);
    const ticker  = await bybit.getTicker(symbol);
    const currentPrice = ticker.last;
    const currentPos   = openPositions[key]?.side || null;

    // Take-profit parcial (opt-in por estratégia) — verificado antes do sinal
    // da estratégia, é gestão de posição e não depende da lógica de entrada/saída.
    // Sem takeProfitSide definido, aplica-se aos dois lados (long e short).
    if (strategy.takeProfitPct && currentPos && (!strategy.takeProfitSide || currentPos === strategy.takeProfitSide)) {
      const pos = openPositions[key];
      if (pos && !pos.tpTaken && pos.entryPrice) {
        const pnlPct = pos.side === 'long'
          ? (currentPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - currentPrice) / pos.entryPrice;
        if (pnlPct >= strategy.takeProfitPct) {
          await partialTakeProfit(strategy, symbol, key, currentPrice);
        }
      }
    }

    // Take-profit em vários níveis (opt-in via strategy.takeProfitTiers — array
    // de { pct, fraction }, ex: [{pct:0.08,fraction:0.30},{pct:0.45,fraction:0.30}]).
    // Independente do takeProfitPct simples acima (usa-se um ou outro por
    // estratégia). Cada fraction fecha essa % da quantidade AINDA aberta
    // nesse momento (não da entrada original) — mesma semântica do
    // takeProfitCloseFraction simples, só repetida por cada nível. Avança
    // pos.tpTierIndex a cada nível disparado; o resto fica para a saída por
    // sinal da própria estratégia (ex: preço abaixo de uma média).
    if (strategy.takeProfitTiers?.length && currentPos) {
      const pos = openPositions[key];
      const tierIdx = pos?.tpTierIndex ?? 0;
      const tier = strategy.takeProfitTiers[tierIdx];
      if (pos && tier && pos.entryPrice) {
        const pnlPct = pos.side === 'long'
          ? (currentPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - currentPrice) / pos.entryPrice;
        if (pnlPct >= tier.pct) {
          await partialTakeProfitTier(strategy, symbol, key, currentPrice, tier);
        }
      }
    }

    // Stop-loss "de papel" — a ordem real na Bybit já tem o SL anexado (ver
    // openPosition), mas isso só protege quando a estratégia está ligada. Em
    // modo estudo (enabled=false) essa ordem não existe, por isso replicamos
    // aqui o mesmo limite para os trades de papel respeitarem o SL também.
    const slPct = stopLossPctFor(strategy, currentPos);
    if (slPct && currentPos) {
      const pos = openPositions[key];
      if (pos && pos.entryPrice) {
        const lossPct = pos.side === 'long'
          ? (pos.entryPrice - currentPrice) / pos.entryPrice
          : (currentPrice - pos.entryPrice) / pos.entryPrice;
        if (lossPct >= slPct) {
          const logLine = `🛑 [${symbol.split('/')[0]}] Stop-loss (${(slPct * 100).toFixed(0)}%) atingido — fecha a $${currentPrice}`;
          runState.log.unshift(logLine);
          if (runState.log.length > 200) runState.log.pop();
          console.log(`[${strategy.name}] ${logLine}`);
          await closePositionFully(strategy, symbol, key, currentPrice);
          return;
        }
      }
    }

    // Trailing stop (opt-in via strategy.trailingStopPct) — só ATIVA depois
    // de a posição entrar em lucro pela primeira vez; antes disso não há
    // proteção nenhuma, o movimento inicial fica livre. Uma vez ativo, fica
    // sempre ativo. Testado nos estudos da PumpEmaSpread (26/08): a versão
    // "desde a entrada" cortava os melhores trades em minutos (ex: BTR,
    // +227% flutuante reduzido a +4,79 realizado); "a partir do lucro"
    // recuperou grande parte disso (+10,49). Independente do SL fixo — se
    // ambos estiverem configurados, o que disparar primeiro fecha a
    // posição. extremePrice/trailActive não são persistidos em BD; ao
    // reiniciar o servidor recomeçam do zero (ver loadOpenPositions).
    if (strategy.trailingStopPct && currentPos) {
      const pos = openPositions[key];
      if (pos && pos.entryPrice) {
        if (!pos.trailActive) {
          const nowInProfit = pos.side === 'long' ? currentPrice > pos.entryPrice : currentPrice < pos.entryPrice;
          if (nowInProfit) pos.trailActive = true;
        }
      }
      if (pos && pos.entryPrice && pos.trailActive) {
        pos.extremePrice = pos.side === 'long'
          ? Math.max(pos.extremePrice ?? pos.entryPrice, currentPrice)
          : Math.min(pos.extremePrice ?? pos.entryPrice, currentPrice);
        const trailPrice = pos.side === 'long'
          ? pos.extremePrice * (1 - strategy.trailingStopPct)
          : pos.extremePrice * (1 + strategy.trailingStopPct);
        const trailHit = pos.side === 'long' ? currentPrice <= trailPrice : currentPrice >= trailPrice;
        if (trailHit) {
          const logLine = `📉 [${symbol.split('/')[0]}] Trailing stop (${(strategy.trailingStopPct * 100).toFixed(0)}%) atingido — extremo $${pos.extremePrice} → fecha a $${currentPrice}`;
          runState.log.unshift(logLine);
          if (runState.log.length > 200) runState.log.pop();
          console.log(`[${strategy.name}] ${logLine}`);
          await closePositionFully(strategy, symbol, key, currentPrice);
          return;
        }
      }
    }

    // Hold máximo (opt-in por estratégia via strategy.maxHoldHours) — fecha a
    // posição passadas N horas desde a entrada, independente do sinal da
    // estratégia (ex: Top4RotationFade fecha tudo ao fim de ~4h).
    if (strategy.maxHoldHours && currentPos) {
      const pos = openPositions[key];
      if (pos && pos.openedAt) {
        const heldMs = Date.now() - pos.openedAt;
        if (heldMs >= strategy.maxHoldHours * 60 * 60 * 1000) {
          const logLine = `⏳ [${symbol.split('/')[0]}] Hold máximo (${strategy.maxHoldHours}h) atingido — fecha a $${currentPrice}`;
          runState.log.unshift(logLine);
          if (runState.log.length > 200) runState.log.pop();
          console.log(`[${strategy.name}] ${logLine}`);
          await closePositionFully(strategy, symbol, key, currentPrice);
          return;
        }
      }
    }

    // Rank e sessão de scan atuais (1-indexed) — usados por estratégias que
    // dependem da posição no ranking, não das velas (ex: EMA90TopFade,
    // EMA200Top5). scannedAt identifica a sessão de scan em curso —
    // permite a estratégias como a EMA200Top5 saber quando uma sessão nova
    // começou, para fechar tudo e reabrir o ranking atual.
    let rank = null;
    let scannedAt = null;
    if (strategy.scannerPeriod) {
      const scan = getScannerState(strategy.scannerPeriod);
      const idx = scan.results?.findIndex(r => r.symbol === symbol) ?? -1;
      rank = idx >= 0 ? idx + 1 : null;
      scannedAt = scan.scannedAt ?? null;
    } else if (strategy.symbolSource === 'gainers24h') {
      const scan = getGainersState();
      const idx = scan.results?.findIndex(r => r.symbol === symbol) ?? -1;
      rank = idx >= 0 ? idx + 1 : null;
      scannedAt = scan.scannedAt ?? null;
    }

    const posForSession = openPositions[key];
    const newScanSession = !!(posForSession && posForSession.scanTs != null && scannedAt != null && scannedAt !== posForSession.scanTs);

    const qqqPositive = strategy.qqqShortFilter ? await getQqqPositive() : null;
    const btcBullish  = strategy.btcTrendFilter ? await getBtcBullish() : null;

    const { signal, reason, indicators } = strategy.generateSignal(candles, currentPos, { rank, scannedAt, newScanSession, qqqPositive, btcBullish });

    const isAction = signal !== 'hold' && signal !== 'none';
    const icon = isAction ? '🔔' : '·';
    const logLine = `${icon} [${symbol.split('/')[0]}] ${signal} — ${reason}`;
    runState.log.unshift(logLine);
    if (runState.log.length > 200) runState.log.pop();
    console.log(`[${strategy.name}] ${logLine}`);

    if (isAction) {
      // Verifica cooldown (evita duplicados dentro da mesma vela)
      if (isOnCooldown(strategy.name, symbol, signal, strategy.timeframe)) {
        _counts.holds++;
        const skip = `· [${symbol.split('/')[0]}] duplicado ignorado (${signal} em cooldown)`;
        runState.log.unshift(skip);
      } else {
        _counts.signals++;
        setCooldown(strategy.name, symbol, signal);
        await saveSignal(strategy.name, symbol, signal, currentPrice, strategy.timeframe, indicators);

        if (signal === 'long' || signal === 'flip_to_long') {
          await openPosition(strategy, symbol, key, 'long', currentPrice, reason, scannedAt);
        } else if (signal === 'short' || signal === 'flip_to_short') {
          await openPosition(strategy, symbol, key, 'short', currentPrice, reason, scannedAt);
        } else if (signal === 'close_long' || signal === 'close_short') {
          await closePositionFully(strategy, symbol, key, currentPrice);
        }
      }
    } else {
      _counts.holds++;
    }
  } catch (err) {
    _counts.errors++;
    const errLine = `❌ [${symbol.split('/')[0]}] Erro: ${err.message}`;
    runState.log.unshift(errLine);
    console.error(`[${strategy.name}] ${errLine}`);
  }
}

// Grava a posição na BD e em memória assim que o sinal dispara — não espera
// pela ordem real na exchange. Sem isto, um restart do servidor perde o
// estado (só vive em memória) e reabre posições que já tinham sido "abertas"
// antes, disparando sinais de entrada duplicados (ver EMA90TopFade 13/07).
//
// strategy.enabled controla só a ordem REAL na Bybit — os sinais e o
// registo de trades "de papel" na BD (para stats/estudo) acontecem sempre,
// esteja a estratégia ligada à Bybit ou não.
async function openPosition(strategy, symbol, key, side, currentPrice, reason, scanTs = null) {
  if (openPositions[key]?.tradeId) {
    await tryClosePositionOnExchange(strategy, symbol);
    await closeTrade(openPositions[key].tradeId, currentPrice);
  }

  // Fecha primeiro posições de outras estratégias configuradas em
  // closesPositionsOf, no mesmo símbolo — evita ficar comprado e vendido ao
  // mesmo tempo via duas estratégias diferentes (ex: CandleBreakoutShort
  // fecha uma posição aberta da CandleBreakoutLong antes de entrar).
  if (strategy.closesPositionsOf?.length) {
    for (const otherName of strategy.closesPositionsOf) {
      const otherKey = `${otherName}_${symbol}`;
      if (!openPositions[otherKey]?.tradeId) continue;
      const otherStrategy = STRATEGIES.find(s => s.name === otherName);
      if (!otherStrategy) continue;
      const logLine = `⚠️ [${symbol.split('/')[0]}] ${strategy.name} fecha posição aberta da ${otherName} antes de entrar`;
      runState.log.unshift(logLine);
      console.log(`[${strategy.name}] ${logLine}`);
      await closePositionFully(otherStrategy, symbol, otherKey, currentPrice);
    }
  }

  const qty = (strategy.positionSize / currentPrice).toFixed(4);
  const slPct = stopLossPctFor(strategy, side);
  const tradeId = await openTrade(strategy.name, symbol, side, currentPrice, qty, { reason, stopLossPct: slPct });
  openPositions[key] = { tradeId, side, entryPrice: currentPrice, extremePrice: currentPrice, trailActive: false, qty: parseFloat(qty), tpTaken: false, tpTierIndex: 0, scanTs, openedAt: Date.now() };

  if (!strategy.enabled) return; // Bybit desligado — fica só na simulação/estudo

  const orderParams = slPct
    ? { stopLoss: (currentPrice * (side === 'long' ? 1 - slPct : 1 + slPct)).toFixed(8) }
    : {};
  try {
    await bybit.placeMarketOrder(symbol, side === 'long' ? 'buy' : 'sell', parseFloat(qty), orderParams);
  } catch (err) {
    console.warn(`[${strategy.name}] Ordem real falhou para ${symbol} (posição já ficou registada na BD, sem execução na Bybit): ${err.message}`);
  }
}

// Take-profit parcial (opt-in por estratégia via strategy.takeProfitPct) —
// gestão de posição, independente do sinal da estratégia nessa vela.
async function partialTakeProfit(strategy, symbol, key, currentPrice) {
  const pos = openPositions[key];
  if (!pos || pos.tpTaken || !pos.tradeId || !pos.qty) return;

  const result = await partialCloseTrade(pos.tradeId, currentPrice, strategy.takeProfitCloseFraction);
  if (!result) return;

  pos.qty = result.remainingQty;
  pos.tpTaken = true;

  const pct = (strategy.takeProfitCloseFraction * 100).toFixed(0);
  const logLine = `🎯 [${symbol.split('/')[0]}] Take-profit parcial (${pct}%) — lucro ${result.pnlPct.toFixed(1)}%`;
  runState.log.unshift(logLine);
  console.log(`[${strategy.name}] ${logLine}`);

  if (!strategy.enabled) return; // Bybit desligado — fica só no estudo

  try {
    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
    await bybit.placeMarketOrder(symbol, closeSide, result.closeQty, { reduceOnly: true });
  } catch (err) {
    console.warn(`[${strategy.name}] Ordem de TP parcial falhou para ${symbol} (BD já atualizada): ${err.message}`);
  }
}

// Take-profit em vários níveis (opt-in via strategy.takeProfitTiers) — mesma
// mecânica da partialTakeProfit acima, mas avança pos.tpTierIndex em vez de
// um booleano único, para poder disparar vários níveis ao longo da vida da
// posição (ex: TP1 a +8% fecha 30%, TP2 a +45% fecha mais 30%, o resto sai
// só pelo sinal de saída da própria estratégia).
async function partialTakeProfitTier(strategy, symbol, key, currentPrice, tier) {
  const pos = openPositions[key];
  if (!pos || !pos.tradeId || !pos.qty) return;

  const result = await partialCloseTrade(pos.tradeId, currentPrice, tier.fraction);
  if (!result) return;

  pos.qty = result.remainingQty;
  pos.tpTierIndex = (pos.tpTierIndex ?? 0) + 1;

  const pct = (tier.fraction * 100).toFixed(0);
  const logLine = `🎯 [${symbol.split('/')[0]}] TP${pos.tpTierIndex} parcial (${pct}% do que restava) a +${(tier.pct * 100).toFixed(0)}% — lucro ${result.pnlPct.toFixed(1)}%`;
  runState.log.unshift(logLine);
  console.log(`[${strategy.name}] ${logLine}`);

  if (!strategy.enabled) return; // Bybit desligado — fica só no estudo

  try {
    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
    await bybit.placeMarketOrder(symbol, closeSide, result.closeQty, { reduceOnly: true });
  } catch (err) {
    console.warn(`[${strategy.name}] Ordem de TP parcial (nível ${pos.tpTierIndex}) falhou para ${symbol} (BD já atualizada): ${err.message}`);
  }
}

async function closePositionFully(strategy, symbol, key, currentPrice) {
  if (openPositions[key]?.tradeId) {
    await tryClosePositionOnExchange(strategy, symbol);
    await closeTrade(openPositions[key].tradeId, currentPrice);
  }
  delete openPositions[key];
}

async function tryClosePositionOnExchange(strategy, symbol) {
  if (!strategy.enabled) return; // Bybit desligado — nada para fechar na exchange
  try {
    await bybit.closePosition(symbol);
  } catch (err) {
    console.warn(`[${strategy.name}] Fecho real falhou para ${symbol} (BD atualizada na mesma): ${err.message}`);
  }
}

// Símbolos com posição aberta numa estratégia (chave: "NomeEstrategia_simbolo")
function symbolsWithOpenPositions(strategyName) {
  const prefix = `${strategyName}_`;
  return Object.keys(openPositions)
    .filter(k => k.startsWith(prefix))
    .map(k => k.slice(prefix.length));
}

// Resolve símbolos para uma estratégia
function resolveSymbols(strategy) {
  let symbols;
  if (strategy.symbols?.length) {
    // Lista fixa de símbolos (array), sem depender de scanner nem da BD de
    // stocks — usada por estratégias com um universo curado à mão (ex:
    // Top10 de um backtest).
    symbols = strategy.symbols;
  } else if (strategy.symbolSource === 'stocks') {
    symbols = stockSymbolsCache;
  } else if (strategy.symbolSource === 'gainers24h') {
    const scan = getGainersState();
    symbols = (scan.status === 'done' && scan.results?.length) ? scan.results.map(r => r.symbol) : [];
    // results já vem ordenado por change24h desc — topN restringe ao ranking de topo
    if (strategy.topN) symbols = symbols.slice(0, strategy.topN);
  } else if (strategy.symbolSource === 'gainers24hDropped') {
    // Só os símbolos que estavam no Top N do scan anterior e já não estão no
    // atual — usado pela Top4RotationFade para detetar quem acabou de sair.
    const scan = getGainersState();
    if (scan.status === 'done') {
      const current = new Set((scan.results || []).map(r => r.symbol));
      symbols = (scan.previousResults || []).map(r => r.symbol).filter(s => !current.has(s));
    } else {
      symbols = [];
    }
  } else if (strategy.symbolSource === 'emaTrendTotal') {
    const scan = getEmaTrendTotalState();
    symbols = (scan.status === 'done' && scan.results?.length) ? scan.results.map(r => r.symbol) : [];
  } else if (strategy.symbolSource === 'pump24h') {
    const scan = getPumpState();
    symbols = (scan.status === 'done' && scan.results?.length) ? scan.results.map(r => r.symbol) : [];
  } else if (!strategy.scannerPeriod) {
    symbols = [strategy.symbol];
  } else {
    const scan = getScannerState(strategy.scannerPeriod);
    symbols = (scan.status === 'done' && scan.results?.length) ? scan.results.map(r => r.symbol) : [];
    // results já vem ordenado por pct_above desc — topN restringe ao topo do ranking
    // (a estratégia volta a validar o rank em generateSignal via context.rank).
    if (strategy.topN) symbols = symbols.slice(0, strategy.topN);
  }

  // Garante que um símbolo com posição aberta continua a ser avaliado mesmo que
  // tenha saído da lista do scanner — evita posições "órfãs" que nunca mais
  // recebem sinal de saída (ver estudo de ranking das estratégias).
  const openSymbols = symbolsWithOpenPositions(strategy.name);
  if (openSymbols.length) {
    symbols = [...new Set([...symbols, ...openSymbols])];
  }
  return symbols;
}

// Corre o scanner certo para uma estratégia, se ainda não tiver símbolos disponíveis
async function ensureSymbols(strategy) {
  if (resolveSymbols(strategy).length > 0) return;
  if (strategy.scannerPeriod) {
    await startScan(strategy.scannerPeriod, 50);
  } else if (strategy.symbolSource === 'gainers24h' || strategy.symbolSource === 'gainers24hDropped') {
    await startScanGainers(4);
  } else if (strategy.symbolSource === 'emaTrendTotal') {
    await startScanEmaTrendTotal();
  } else if (strategy.symbolSource === 'pump24h') {
    await startScanPump(10);
  }
}

function scannerLabel(strategy) {
  if (strategy.scannerPeriod) return `Scanner EMA${strategy.scannerPeriod}`;
  if (strategy.symbolSource === 'gainers24h' || strategy.symbolSource === 'gainers24hDropped') return 'Scanner Top 24h';
  if (strategy.symbolSource === 'emaTrendTotal') return 'Scanner EMA Trend (sem limite)';
  if (strategy.symbolSource === 'pump24h') return 'Scanner Pump 24h';
  return 'Scanner';
}

// Corre sempre, mesmo com strategy.enabled=false (Bybit desligado) — sinais e
// trades "de papel" continuam a ser gerados/registados para estudo. Ver
// openPosition/tryClosePositionOnExchange para onde o enabled é respeitado.
async function runStrategy(strategy) {
  await ensureSymbols(strategy);
  let symbols = resolveSymbols(strategy);
  if (!symbols.length) {
    console.log(`[${strategy.name}] Sem símbolos — corre o ${scannerLabel(strategy)} primeiro.`);
    return;
  }
  if (strategy.symbolExclude?.length) {
    symbols = symbols.filter(s => !strategy.symbolExclude.includes(s.split('/')[0]));
  }
  for (const symbol of symbols) {
    await runStrategyOnSymbol(strategy, symbol);
  }
}

async function runAll() {
  if (runState.running) return;
  _counts = { signals: 0, holds: 0, errors: 0 };
  runState = { running: true, phase: null, strategy: null, current: 0, total: 0, log: runState.log, summary: runState.summary };

  let totalAnalyzed = 0;
  try {
    // Pré-passo: correr scanner automático para estratégias dinâmicas sem símbolos
    // (corre para todas, mesmo com Bybit desligado — sinais/estudo continuam)
    for (const strategy of STRATEGIES) {
      const isDynamicSource = strategy.scannerPeriod || strategy.symbolSource === 'gainers24h' ||
        strategy.symbolSource === 'gainers24hDropped' || strategy.symbolSource === 'emaTrendTotal' ||
        strategy.symbolSource === 'pump24h';
      if (!isDynamicSource) continue;
      if (resolveSymbols(strategy).length === 0) {
        const label = scannerLabel(strategy);
        const msg = `🔍 ${label} não tem dados — a correr automaticamente...`;
        runState.log.unshift(msg);
        runState.phase = `scanner_${strategy.scannerPeriod || strategy.symbolSource}`;
        console.log(`[Runner] ${msg}`);
        await ensureSymbols(strategy);
        const n = resolveSymbols(strategy).length;
        const doneMsg = `✅ ${label} concluído — ${n} símbolos carregados`;
        runState.log.unshift(doneMsg);
        console.log(`[Runner] ${doneMsg}`);
      }
    }

    runState.phase = 'running';

    for (const strategy of STRATEGIES) {
      // Estratégias de 15m já são corridas pelo cron dedicado a cada 15 min.
      // Avaliá-las aqui também (runAll corre a cada hora, no arranque e no botão
      // "Executar Agora") apanha-as fora de ciclo, a meio de uma vela de 15m
      // ainda a formar-se — foi isso que causou o whipsaw entra/sai da
      // CandleBreakoutShort em KAITO (29/07, ~18h-19h): sinais a 5min de
      // distância em vez dos 15min esperados.
      if (strategy.timeframe === '15m') continue;

      const symbols = resolveSymbols(strategy);

      if (!symbols.length) {
        const warn = `⚠️  [${strategy.name}] Sem símbolos após scanner — a saltar`;
        runState.log.unshift(warn);
        console.warn(warn);
        continue;
      }

      runState.strategy = strategy.name;
      runState.current  = 0;
      runState.total    = symbols.length;

      for (const symbol of symbols) {
        runState.current++;
        totalAnalyzed++;
        await runStrategyOnSymbol(strategy, symbol);
      }
    }
  } finally {
    runState.running  = false;
    runState.strategy = null;
    runState.summary  = {
      finishedAt: new Date().toISOString(),
      analyzed:   totalAnalyzed,
      signals:    _counts.signals,
      holds:      _counts.holds,
      errors:     _counts.errors,
    };
    const sumLine = `✅ Concluído — ${totalAnalyzed} analisados · ${_counts.signals} sinais · ${_counts.holds} hold · ${_counts.errors} erros`;
    runState.log.unshift(sumLine);
    console.log(sumLine);
  }
}

// Carrega posições abertas da BD ao arrancar (sobrevive a reinicios)
async function loadOpenPositions() {
  try {
    const { rows } = await pool.query(`SELECT strategy_name, symbol, side, id, entry_price, quantity, opened_at FROM trades WHERE status='open'`);
    rows.forEach(r => {
      const key = `${r.strategy_name}_${r.symbol}`;
      const entryPrice = parseFloat(r.entry_price);
      const qty = parseFloat(r.quantity);
      const strategy = STRATEGIES.find(s => s.name === r.strategy_name);
      // Heurística para restaurar tpTaken/tpTierIndex após um restart: se a
      // quantidade guardada é visivelmente menor que a posição cheia
      // esperada, é porque já houve take-profit(s) parciais (não há flag
      // persistida para isto). Para takeProfitTiers, estima quantos níveis
      // já dispararam comparando a qty restante com a fração acumulada
      // esperada após cada nível (cada fraction fecha % do que restava
      // nesse momento, não da entrada original — ver partialTakeProfitTier).
      let tpTaken = false;
      let tpTierIndex = 0;
      if (strategy?.positionSize && entryPrice > 0) {
        const expectedFullQty = strategy.positionSize / entryPrice;
        if (strategy.takeProfitPct) {
          tpTaken = qty < expectedFullQty * 0.99;
        }
        if (strategy.takeProfitTiers?.length) {
          let remainingFrac = 1;
          for (const tier of strategy.takeProfitTiers) {
            const fracAfterTier = remainingFrac * (1 - tier.fraction);
            if (qty < expectedFullQty * fracAfterTier * 1.01) {
              tpTierIndex++;
              remainingFrac = fracAfterTier;
            } else break;
          }
        }
      }
      openPositions[key] = { tradeId: r.id, side: r.side, entryPrice, extremePrice: entryPrice, trailActive: false, qty, tpTaken, tpTierIndex, openedAt: new Date(r.opened_at).getTime() };
    });
    if (rows.length) console.log(`[Runner] ${rows.length} posições abertas carregadas da BD`);
  } catch { /* BD ainda não disponível */ }
}

// Liga/desliga estratégias (persistido em BD — sobrevive a reinicios/deploys).
// A tabela é criada aqui em vez de só no migrate.js para não depender de
// correr a migration manualmente depois do deploy.
async function loadStrategySettings() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS strategy_settings (
        strategy_name VARCHAR(100) PRIMARY KEY,
        enabled       BOOLEAN      NOT NULL DEFAULT true,
        updated_at    TIMESTAMP    DEFAULT NOW()
      )
    `);
    const { rows } = await pool.query('SELECT strategy_name, enabled FROM strategy_settings');
    rows.forEach(r => {
      const strategy = STRATEGIES.find(s => s.name === r.strategy_name);
      if (strategy) strategy.enabled = r.enabled;
    });
    if (rows.length) console.log(`[Runner] ${rows.length} estados de estratégia carregados da BD`);
  } catch { /* BD ainda não disponível */ }
}

async function setStrategyEnabled(strategyName, enabled) {
  const strategy = STRATEGIES.find(s => s.name === strategyName);
  if (!strategy) throw new Error(`Estratégia desconhecida: ${strategyName}`);
  strategy.enabled = enabled;
  try {
    await pool.query(
      `INSERT INTO strategy_settings (strategy_name, enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (strategy_name) DO UPDATE SET enabled = $2, updated_at = NOW()`,
      [strategyName, enabled]
    );
  } catch (err) {
    // Sem BD, o toggle continua a valer em memória (não persiste a reinicios)
    console.warn(`[Runner] Não consegui persistir enabled=${enabled} para ${strategyName}: ${err.message}`);
  }
  return strategy;
}

setTimeout(loadOpenPositions, 5000);
setTimeout(loadStockSymbols, 6000);
setTimeout(loadStrategySettings, 5000);

module.exports = { runAll, runStrategy, STRATEGIES, getRunState, resolveSymbols, getMemorySignals, loadStockSymbols, setStrategyEnabled };
