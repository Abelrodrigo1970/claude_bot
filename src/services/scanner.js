const { EMA } = require('technicalindicators');
const bybit = require('./bybit');

const CACHE_TTL = 60 * 60 * 1000; // 1 hora

let state = {
  status: 'idle',   // 'idle' | 'scanning' | 'done' | 'error'
  progress: 0,
  total: 0,
  results: [],
  scannedAt: null,
  error: null,
};

async function startScan(limit = 50) {
  if (state.status === 'scanning') return;

  // Cache fresco — não re-escanear
  if (state.status === 'done' && state.scannedAt && Date.now() - state.scannedAt < CACHE_TTL) return;

  state = { ...state, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.exchange.loadMarkets();

    // Filtra futuros USDT lineares ativos, ordena por volume e limita a 150
    const perps = Object.values(markets)
      .filter(m => m.linear && m.settle === 'USDT' && m.active && !m.symbol.includes('USDC'))
      .sort((a, b) => parseFloat(b.info.turnover24h || 0) - parseFloat(a.info.turnover24h || 0))
      .slice(0, 250);

    state.total = perps.length;
    const results = [];

    for (let i = 0; i < perps.length; i++) {
      state.progress = i + 1;
      const market = perps[i];

      try {
        const candles = await bybit.getCandles(market.symbol, '1d', 210);
        if (candles.length < 201) continue;

        const closes = candles.map(c => c.close);
        const ema200arr = EMA.calculate({ period: 200, values: closes });
        const lastEma200 = ema200arr[ema200arr.length - 1];
        const lastClose  = closes[closes.length - 1];
        const prevClose  = closes[closes.length - 2];

        if (lastClose > lastEma200) {
          results.push({
            symbol:   market.symbol,
            price:    lastClose,
            ema200:   lastEma200,
            pctAbove: ((lastClose - lastEma200) / lastEma200) * 100,
            change24h: ((lastClose - prevClose) / prevClose) * 100,
            volume:   candles[candles.length - 1].volume * lastClose, // volume em USDT
          });
        }
      } catch {
        // par sem dados suficientes, ignorar
      }
    }

    results.sort((a, b) => b.pctAbove - a.pctAbove);

    state.results   = results.slice(0, limit);
    state.scannedAt = Date.now();
    state.status    = 'done';
  } catch (err) {
    state.status = 'error';
    state.error  = err.message;
  }
}

function getState() { return state; }

module.exports = { startScan, getState };
