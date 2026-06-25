const pool = require('../db/pool');
const bybit = require('./bybit');
const { getState: getScannerState, startScan } = require('./scanner');
const trendSurfer   = require('../strategies/trendSurfer');
const macdRider     = require('../strategies/macdRider');
const bbBreaker     = require('../strategies/bbBreaker');
const stochMomentum = require('../strategies/stochMomentum');

// Registry de estratégias ativas
// scannerPeriod: se definido, os símbolos vêm do scanner em vez de fixos
const STRATEGIES = [
  {
    name: trendSurfer.STRATEGY_NAME,
    symbol: null,          // dinâmico — vem do scanner EMA90
    scannerPeriod: 90,
    timeframe: '1h',
    generateSignal: trendSurfer.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: macdRider.STRATEGY_NAME,
    symbol: null,
    scannerPeriod: 90,
    timeframe: '4h',
    generateSignal: macdRider.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: bbBreaker.STRATEGY_NAME,
    symbol: 'ETH/USDT:USDT',
    timeframe: '1h',
    generateSignal: bbBreaker.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: stochMomentum.STRATEGY_NAME,
    symbol: 'SOL/USDT:USDT',
    timeframe: '1h',
    generateSignal: stochMomentum.generateSignal,
    positionSize: 10,
    enabled: true,
  },
];

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
    const pnl = trade.side === 'long'
      ? (exitPrice - trade.entry_price) * trade.quantity
      : (trade.entry_price - exitPrice) * trade.quantity;
    const pnlPct = trade.side === 'long'
      ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100
      : ((trade.entry_price - exitPrice) / trade.entry_price) * 100;
    await pool.query(
      `UPDATE trades SET exit_price=$1, pnl=$2, pnl_pct=$3, status='closed', closed_at=NOW() WHERE id=$4`,
      [exitPrice, pnl, pnlPct, tradeId]
    );
    await updateStats(trade.strategy_name, trade.symbol, pnl > 0);
  } catch { /* BD não configurada */ }
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

// Estado em memória das posições abertas: { 'TrendSurfer_BTC/USDT:USDT': { tradeId, side } }
const openPositions = {};

// Contadores do run atual
let _counts = { signals: 0, holds: 0, errors: 0 };

async function runStrategyOnSymbol(strategy, symbol) {
  const key = `${strategy.name}_${symbol}`;
  try {
    const candles = await bybit.getCandles(symbol, strategy.timeframe, 250);
    const ticker  = await bybit.getTicker(symbol);
    const currentPrice = ticker.last;
    const currentPos   = openPositions[key]?.side || null;

    const { signal, reason, indicators } = strategy.generateSignal(candles, currentPos);

    const isAction = signal !== 'hold' && signal !== 'none';
    const icon = isAction ? '🔔' : '·';
    const logLine = `${icon} [${symbol.split('/')[0]}] ${signal} — ${reason}`;
    runState.log.unshift(logLine);
    if (runState.log.length > 200) runState.log.pop();
    console.log(`[${strategy.name}] ${logLine}`);

    if (isAction) {
      _counts.signals++;
      await saveSignal(strategy.name, symbol, signal, currentPrice, strategy.timeframe, indicators);
    } else {
      _counts.holds++;
    }

    if (signal === 'long' || signal === 'flip_to_long') {
      if (openPositions[key]) {
        await bybit.closePosition(symbol);
        await closeTrade(openPositions[key].tradeId, currentPrice);
      }
      const qty = (strategy.positionSize / currentPrice).toFixed(4);
      await bybit.placeMarketOrder(symbol, 'buy', parseFloat(qty));
      const tradeId = await openTrade(strategy.name, symbol, 'long', currentPrice, qty, { reason });
      openPositions[key] = { tradeId, side: 'long' };
    }
    else if (signal === 'short' || signal === 'flip_to_short') {
      if (openPositions[key]) {
        await bybit.closePosition(symbol);
        await closeTrade(openPositions[key].tradeId, currentPrice);
      }
      const qty = (strategy.positionSize / currentPrice).toFixed(4);
      await bybit.placeMarketOrder(symbol, 'sell', parseFloat(qty));
      const tradeId = await openTrade(strategy.name, symbol, 'short', currentPrice, qty, { reason });
      openPositions[key] = { tradeId, side: 'short' };
    }
  } catch (err) {
    _counts.errors++;
    const errLine = `❌ [${symbol.split('/')[0]}] Erro: ${err.message}`;
    runState.log.unshift(errLine);
    console.error(`[${strategy.name}] ${errLine}`);
  }
}

// Resolve símbolos para uma estratégia (fixo ou dinâmico via scanner)
function resolveSymbols(strategy) {
  if (!strategy.scannerPeriod) return [strategy.symbol];
  const scan = getScannerState(strategy.scannerPeriod);
  if (scan.status !== 'done' || !scan.results?.length) return [];
  return scan.results.map(r => r.symbol);
}

async function runStrategy(strategy) {
  if (!strategy.enabled) return;
  const symbols = resolveSymbols(strategy);
  if (!symbols.length) {
    console.log(`[${strategy.name}] Sem símbolos — corre o Scanner EMA${strategy.scannerPeriod} primeiro.`);
    return;
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
    for (const strategy of STRATEGIES) {
      if (!strategy.enabled || !strategy.scannerPeriod) continue;
      if (resolveSymbols(strategy).length === 0) {
        const msg = `🔍 Scanner EMA${strategy.scannerPeriod} não tem dados — a correr automaticamente (pode demorar ~1min)...`;
        runState.log.unshift(msg);
        runState.phase = `scanner_ema${strategy.scannerPeriod}`;
        console.log(`[Runner] ${msg}`);
        await startScan(strategy.scannerPeriod, 50);
        const n = resolveSymbols(strategy).length;
        const doneMsg = `✅ Scanner EMA${strategy.scannerPeriod} concluído — ${n} símbolos carregados`;
        runState.log.unshift(doneMsg);
        console.log(`[Runner] ${doneMsg}`);
      }
    }

    runState.phase = 'running';

    for (const strategy of STRATEGIES) {
      if (!strategy.enabled) continue;
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

module.exports = { runAll, runStrategy, STRATEGIES, getRunState, resolveSymbols, getMemorySignals };
