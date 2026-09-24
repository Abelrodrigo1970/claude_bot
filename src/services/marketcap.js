const axios = require('axios');

// Market cap (USD) por símbolo via CoinGecko — API pública, sem API key.
// Cache longo porque market cap não varia tão depressa como preço, e a API
// pública tem rate limit apertado (~10-30 pedidos/min).
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

let cache = { data: null, fetchedAt: 0 };

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Devolve um Map<symbolMaiusculas, marketCapUSD>.
 * Em símbolos duplicados (ex: o mesmo ticker usado em cadeias diferentes),
 * fica o de maior market cap — a API já devolve por market_cap desc, por
 * isso o primeiro a aparecer é sempre o correto.
 */
async function fetchMarketCaps() {
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.data;

  const map = new Map();
  const MAX_PAGES = 12; // até ~3000 moedas — cobre bem o universo acima de 90M
  const MIN_MARKET_CAP = 90_000_000;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
        params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 250, page, sparkline: false },
        timeout: 15000,
      });
      data = resp.data;
    } catch (err) {
      console.warn('[MarketCap] Erro ao pedir página', page, ':', err.message);
      break;
    }
    if (!data || !data.length) break;

    for (const coin of data) {
      const sym = (coin.symbol || '').toUpperCase();
      if (sym && !map.has(sym) && coin.market_cap) map.set(sym, coin.market_cap);
    }

    const last = data[data.length - 1];
    if (!last.market_cap || last.market_cap < MIN_MARKET_CAP) break; // já passámos o limiar
    if (data.length < 250) break; // última página disponível

    await sleep(1500); // evita 429 da API pública do CoinGecko
  }

  console.log(`[MarketCap] ${map.size} moedas carregadas do CoinGecko`);
  cache = { data: map, fetchedAt: Date.now() };
  return map;
}

module.exports = { fetchMarketCaps };
