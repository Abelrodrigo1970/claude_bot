require('dotenv').config();
const ccxt = require('ccxt');

const exchange = new ccxt.bybit({
  apiKey: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_API_SECRET,
  options: {
    defaultType: 'linear', // USDT perpetual
  },
  ...(process.env.BYBIT_TESTNET === 'true' && { hostname: 'api-testnet.bybit.com' }),
});

/**
 * Fetch OHLCV candles
 * @param {string} symbol - e.g. 'BIC/USDT:USDT'
 * @param {string} timeframe - '1h', '15m', etc.
 * @param {number} limit - number of candles
 */
async function getCandles(symbol, timeframe = '1h', limit = 200) {
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  return ohlcv.map(([time, open, high, low, close, volume]) => ({
    time: new Date(time),
    open, high, low, close, volume,
  }));
}

/**
 * Get current position for a symbol
 */
async function getPosition(symbol) {
  const positions = await exchange.fetchPositions([symbol]);
  return positions.find(p => p.symbol === symbol && Math.abs(p.contracts) > 0) || null;
}

/**
 * Place a market order
 * @param {string} symbol
 * @param {'buy'|'sell'} side
 * @param {number} amount - in contracts
 */
async function placeMarketOrder(symbol, side, amount) {
  return await exchange.createOrder(symbol, 'market', side, amount);
}

/**
 * Close current position (flip or close)
 */
async function closePosition(symbol) {
  const position = await getPosition(symbol);
  if (!position) return null;

  const side = position.side === 'long' ? 'sell' : 'buy';
  const amount = Math.abs(position.contracts);
  return await exchange.createOrder(symbol, 'market', side, amount, undefined, {
    reduceOnly: true,
  });
}

/**
 * Get current ticker price
 */
async function getTicker(symbol) {
  return await exchange.fetchTicker(symbol);
}

/**
 * Get account balance
 */
async function getBalance() {
  return await exchange.fetchBalance();
}

module.exports = { getCandles, getPosition, placeMarketOrder, closePosition, getTicker, getBalance, exchange };
