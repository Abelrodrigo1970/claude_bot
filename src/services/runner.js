const pool = require('../db/pool');
const bybit = require('./bybit');
const { getState: getScannerState, startScan, getGainersState, startScanGainers } = require('./scanner');
const trendSurfer         = require('../strategies/trendSurfer');
const macdRider           = require('../strategies/macdRider');
const bbBreaker           = require('../strategies/bbBreaker');
const pumpBreaker         = require('../strategies/pumpBreaker');
const stockRSI            = require('../strategies/stockRSI');
const stockSMA            = require('../strategies/stockSMA');
const candleBreakoutLong  = require('../strategies/candleBreakoutLong');
const candleBreakoutShort = require('../strategies/candleBreakoutShort');
const ema90TopFade        = require('../strategies/ema90TopFade');

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
    positionSize: 10,
    enabled: true,
  },
  {
    name: macdRider.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90,
    timeframe: '4h',
    generateSignal: macdRider.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: bbBreaker.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90,
    timeframe: '1h',
    generateSignal: bbBreaker.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: pumpBreaker.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90,
    timeframe: '1h',
    generateSignal: pumpBreaker.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: stockRSI.STRATEGY_NAME,
    market: 'stock',
    symbol: null,
    symbolSource: 'stocks',
    timeframe: '2h',
    generateSignal: stockRSI.generateSignal,
    positionSize: 10,
    enabled: true,
  },
  {
    name: stockSMA.STRATEGY_NAME,
    market: 'stock',
    symbol: null,
    symbolSource: 'stocks',
    symbolExclude: ['COIN', 'MSTR', 'HOOD'],
    timeframe: '2h',
    generateSignal: stockSMA.generateSignal,
    positionSize: 50,
    stopLossPct: 0.05,
    enabled: true,
  },
  {
    name: candleBreakoutLong.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    symbolSource: 'gainers24h',
    topN: 3, // só os 3 maiores gainers do Top 6 (o resto do universo é ainda mais fino/ilíquido)
    timeframe: '15m',
    generateSignal: candleBreakoutLong.generateSignal,
    positionSize: 10,
    stopLossPct: 0.20,
    enabled: true,
  },
  {
    name: candleBreakoutShort.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    symbolSource: 'gainers24h',
    timeframe: '15m',
    generateSignal: candleBreakoutShort.generateSignal,
    positionSize: 10,
    stopLossPct: 0.20,
    enabled: true,
  },
  {
    name: ema90TopFade.STRATEGY_NAME,
    market: 'crypto',
    symbol: null,
    scannerPeriod: 90,
    timeframe: '1h',
    generateSignal: ema90TopFade.generateSignal,
    positionSize: 10,
    // Sem SL de propósito — no estudo, qualquer SL fixo (5% a 20%) piorou o
    // resultado desta estratégia (PF 3.98 sem SL vs. ≤0.79 com qualquer SL testado).
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
  const tfMs = { '15m': 15, '1h': 60, '2h': 120, '4h': 240, '1d': 1440 }[timeframe] || 60;
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

    // Rank atual do símbolo no scanner (1-indexed) — usado por estratégias que
    // dependem da posição no ranking, não das velas (ex: EMA90TopFade).
    let rank = null;
    if (strategy.scannerPeriod) {
      const scan = getScannerState(strategy.scannerPeriod);
      const idx = scan.results?.findIndex(r => r.symbol === symbol) ?? -1;
      rank = idx >= 0 ? idx + 1 : null;
    }

    const { signal, reason, indicators } = strategy.generateSignal(candles, currentPos, { rank });

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
          await openPosition(strategy, symbol, key, 'long', currentPrice, reason);
        } else if (signal === 'short' || signal === 'flip_to_short') {
          await openPosition(strategy, symbol, key, 'short', currentPrice, reason);
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
async function openPosition(strategy, symbol, key, side, currentPrice, reason) {
  if (openPositions[key]?.tradeId) {
    await tryClosePositionOnExchange(strategy, symbol);
    await closeTrade(openPositions[key].tradeId, currentPrice);
  }
  const qty = (strategy.positionSize / currentPrice).toFixed(4);
  const tradeId = await openTrade(strategy.name, symbol, side, currentPrice, qty, { reason, stopLossPct: strategy.stopLossPct });
  openPositions[key] = { tradeId, side };

  if (!strategy.enabled) return; // Bybit desligado — fica só na simulação/estudo

  const orderParams = strategy.stopLossPct
    ? { stopLoss: (currentPrice * (side === 'long' ? 1 - strategy.stopLossPct : 1 + strategy.stopLossPct)).toFixed(8) }
    : {};
  try {
    await bybit.placeMarketOrder(symbol, side === 'long' ? 'buy' : 'sell', parseFloat(qty), orderParams);
  } catch (err) {
    console.warn(`[${strategy.name}] Ordem real falhou para ${symbol} (posição já ficou registada na BD, sem execução na Bybit): ${err.message}`);
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
  if (strategy.symbolSource === 'stocks') {
    symbols = stockSymbolsCache;
  } else if (strategy.symbolSource === 'gainers24h') {
    const scan = getGainersState();
    symbols = (scan.status === 'done' && scan.results?.length) ? scan.results.map(r => r.symbol) : [];
    // results já vem ordenado por change24h desc — topN restringe ao ranking de topo
    if (strategy.topN) symbols = symbols.slice(0, strategy.topN);
  } else if (!strategy.scannerPeriod) {
    symbols = [strategy.symbol];
  } else {
    const scan = getScannerState(strategy.scannerPeriod);
    symbols = (scan.status === 'done' && scan.results?.length) ? scan.results.map(r => r.symbol) : [];
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
  } else if (strategy.symbolSource === 'gainers24h') {
    await startScanGainers(6);
  }
}

function scannerLabel(strategy) {
  if (strategy.scannerPeriod) return `Scanner EMA${strategy.scannerPeriod}`;
  if (strategy.symbolSource === 'gainers24h') return 'Scanner Top 24h';
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
      if (!strategy.scannerPeriod && strategy.symbolSource !== 'gainers24h') continue;
      if (resolveSymbols(strategy).length === 0) {
        const label = scannerLabel(strategy);
        const msg = `🔍 ${label} não tem dados — a correr automaticamente...`;
        runState.log.unshift(msg);
        runState.phase = `scanner_${strategy.scannerPeriod || 'gainers24h'}`;
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
    const { rows } = await pool.query(`SELECT strategy_name, symbol, side, id FROM trades WHERE status='open'`);
    rows.forEach(r => {
      const key = `${r.strategy_name}_${r.symbol}`;
      openPositions[key] = { tradeId: r.id, side: r.side };
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
