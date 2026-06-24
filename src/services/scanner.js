const { EMA } = require('technicalindicators');
const bybit = require('./bybit');

const CACHE_TTL = 60 * 60 * 1000;

const VALID_PERIODS = [200, 90];

const states = Object.fromEntries(
  VALID_PERIODS.map(p => [p, { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null }])
);

async function startScan(period = 200, limit = 50) {
  if (!VALID_PERIODS.includes(period)) return;
  const s = states[period];
  if (s.status === 'scanning') return;
  if (s.status === 'done' && s.scannedAt && Date.now() - s.scannedAt < CACHE_TTL) return;

  states[period] = { ...s, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.exchange.loadMarkets();

    const perps = Object.values(markets)
      .filter(m => m.linear && m.settle === 'USDT' && m.active && !m.symbol.includes('USDC'))
      .sort((a, b) => parseFloat(b.info.turnover24h || 0) - parseFloat(a.info.turnover24h || 0))
      .slice(0, 250);

    states[period].total = perps.length;
    const results = [];
    const needed = period + 10;

    for (let i = 0; i < perps.length; i++) {
      states[period].progress = i + 1;
      const market = perps[i];

      try {
        const candles = await bybit.getCandles(market.symbol, '1d', needed + 5);
        if (candles.length < needed) continue;

        const closes = candles.map(c => c.close);
        const emaArr = EMA.calculate({ period, values: closes });
        const lastEma   = emaArr[emaArr.length - 1];
        const lastClose = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2];

        if (lastClose > lastEma) {
          results.push({
            symbol:    market.symbol,
            price:     lastClose,
            ema:       lastEma,
            pctAbove:  ((lastClose - lastEma) / lastEma) * 100,
            change24h: ((lastClose - prevClose) / prevClose) * 100,
            volume:    candles[candles.length - 1].volume * lastClose,
          });
        }
      } catch {
        // par sem dados suficientes, ignorar
      }
    }

    results.sort((a, b) => b.pctAbove - a.pctAbove);
    states[period].results   = results.slice(0, limit);
    states[period].scannedAt = Date.now();
    states[period].status    = 'done';
  } catch (err) {
    states[period].status = 'error';
    states[period].error  = err.message;
  }
}

function getState(period = 200) {
  return states[period] || states[200];
}

module.exports = { startScan, getState };
