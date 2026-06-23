const pool = require('../db/pool');
const bybit = require('./bybit');
const trendSurfer = require('../strategies/trendSurfer');

// Registry de estratégias ativas
const STRATEGIES = [
  {
    name: trendSurfer.STRATEGY_NAME,
    symbol: 'BIC/USDT:USDT',
    timeframe: '1h',
    generateSignal: trendSurfer.generateSignal,
    positionSize: 10, // USDT
    enabled: true,
  },
  // Adiciona mais estratégias aqui no futuro
];

/**
 * Salva sinal na DB
 */
async function saveSignal(strategyName, symbol, signalType, price, timeframe, indicators) {
  await pool.query(
    `INSERT INTO signals (strategy_name, symbol, signal_type, price, timeframe, indicators)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [strategyName, symbol, signalType, price, timeframe, JSON.stringify(indicators)]
  );
}

/**
 * Abre trade na DB
 */
async function openTrade(strategyName, symbol, side, entryPrice, quantity, metadata = {}) {
  const result = await pool.query(
    `INSERT INTO trades (strategy_name, symbol, side, entry_price, quantity, metadata)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [strategyName, symbol, side, entryPrice, quantity, JSON.stringify(metadata)]
  );
  return result.rows[0].id;
}

/**
 * Fecha trade na DB e calcula PnL
 */
async function closeTrade(tradeId, exitPrice) {
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

  // Atualiza estatísticas
  await updateStats(trade.strategy_name, trade.symbol, pnl > 0);
}

/**
 * Atualiza estatísticas da estratégia
 */
async function updateStats(strategyName, symbol, isWin) {
  await pool.query(
    `INSERT INTO strategy_stats (strategy_name, symbol, total_trades, winning_trades, total_pnl)
     VALUES ($1, $2, 1, $3, 0)
     ON CONFLICT (strategy_name, symbol)
     DO UPDATE SET
       total_trades = strategy_stats.total_trades + 1,
       winning_trades = strategy_stats.winning_trades + $3,
       win_rate = (strategy_stats.winning_trades + $3)::decimal / (strategy_stats.total_trades + 1) * 100,
       updated_at = NOW()`,
    [strategyName, symbol, isWin ? 1 : 0]
  );
}

// Estado em memória das posições abertas por estratégia
const openPositions = {}; // { 'TrendSurfer_BIC/USDT:USDT': { tradeId, side } }

/**
 * Executa uma estratégia
 */
async function runStrategy(strategy) {
  if (!strategy.enabled) return;

  const key = `${strategy.name}_${strategy.symbol}`;

  try {
    console.log(`\n[${strategy.name}] Executando para ${strategy.symbol}...`);

    const candles = await bybit.getCandles(strategy.symbol, strategy.timeframe, 250);
    const ticker = await bybit.getTicker(strategy.symbol);
    const currentPrice = ticker.last;

    const currentPos = openPositions[key]?.side || null;
    const { signal, reason, indicators } = strategy.generateSignal(candles, currentPos);

    console.log(`[${strategy.name}] Sinal: ${signal} | ${reason}`);

    // Guarda sinal na DB sempre
    if (signal !== 'hold' && signal !== 'none') {
      await saveSignal(strategy.name, strategy.symbol, signal, currentPrice, strategy.timeframe, indicators);
    }

    // Executa ordem
    if (signal === 'long' || signal === 'flip_to_long') {
      // Fecha posição short se existir
      if (openPositions[key]) {
        await bybit.closePosition(strategy.symbol);
        await closeTrade(openPositions[key].tradeId, currentPrice);
        console.log(`[${strategy.name}] Fechou SHORT em ${currentPrice}`);
      }

      // Abre long
      const qty = (strategy.positionSize / currentPrice).toFixed(4);
      await bybit.placeMarketOrder(strategy.symbol, 'buy', parseFloat(qty));
      const tradeId = await openTrade(strategy.name, strategy.symbol, 'long', currentPrice, qty, { reason });
      openPositions[key] = { tradeId, side: 'long' };
      console.log(`[${strategy.name}] ✅ LONG aberto em ${currentPrice}`);
    }

    else if (signal === 'short' || signal === 'flip_to_short') {
      // Fecha posição long se existir
      if (openPositions[key]) {
        await bybit.closePosition(strategy.symbol);
        await closeTrade(openPositions[key].tradeId, currentPrice);
        console.log(`[${strategy.name}] Fechou LONG em ${currentPrice}`);
      }

      // Abre short
      const qty = (strategy.positionSize / currentPrice).toFixed(4);
      await bybit.placeMarketOrder(strategy.symbol, 'sell', parseFloat(qty));
      const tradeId = await openTrade(strategy.name, strategy.symbol, 'short', currentPrice, qty, { reason });
      openPositions[key] = { tradeId, side: 'short' };
      console.log(`[${strategy.name}] ✅ SHORT aberto em ${currentPrice}`);
    }

  } catch (err) {
    console.error(`[${strategy.name}] Erro:`, err.message);
  }
}

/**
 * Corre todas as estratégias
 */
async function runAll() {
  for (const strategy of STRATEGIES) {
    await runStrategy(strategy);
  }
}

module.exports = { runAll, STRATEGIES };
