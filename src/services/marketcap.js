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

// ─── TOP N CRIPTO POR MARKET CAP (com perpétuo na Bybit) ─────────
// Top por market cap sem stablecoins (categoria "stablecoins" do CoinGecko),
// sem versões wrapped/staked/bridged (duplicados de BTC/ETH) e sem ouro
// tokenizado. Cada moeda é mapeada para o perpétuo USDT da Bybit — incluindo
// os prefixos de multiplicador (1000PEPE, SHIB1000…) — e só entra se o preço
// bater (±10%) com o do CoinGecko, para não confundir tickers iguais de
// moedas diferentes. Mesma lógica do estudo da RsiReversal29.
const TOP_MC_TTL = 6 * 60 * 60 * 1000; // 6h
const EXCLUDE_WORDS = ['wrapped', 'staked', 'bridged', 'restaked', 'binance-peg'];
const EXCLUDE_SYMBOLS = new Set(['XAUT', 'PAXG']); // ouro tokenizado

let topMcCache = { symbols: [], fetchedAt: 0 };

async function fetchTopCryptoPerps(publicExchange, n = 30) {
  if (topMcCache.symbols.length >= n && Date.now() - topMcCache.fetchedAt < TOP_MC_TTL) {
    return topMcCache.symbols.slice(0, n);
  }
  try {
    const cg = (params) => axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency: 'usd', order: 'market_cap_desc', sparkline: false, page: 1, ...params },
      timeout: 15000,
    }).then(r => r.data);
    const coins = await cg({ per_page: 150 });
    await sleep(1500); // evita 429 da API pública
    const stableIds = new Set((await cg({ category: 'stablecoins', per_page: 250 })).map(c => c.id));

    const tickers = await publicExchange.fetchTickers(undefined, { category: 'linear' });
    const byRaw = new Map(); // 'SHIB1000USDT' -> { symbol: 'SHIB1000/USDT:USDT', price }
    for (const t of Object.values(tickers)) {
      if (t.info?.symbol && t.symbol?.endsWith('/USDT:USDT')) {
        byRaw.set(t.info.symbol, { symbol: t.symbol, price: parseFloat(t.info.lastPrice || t.last || 0) });
      }
    }

    const out = [];
    for (const c of coins) {
      const sym = (c.symbol || '').toUpperCase();
      const idName = `${c.id} ${(c.name || '').toLowerCase()}`;
      if (!sym || stableIds.has(c.id) || EXCLUDE_SYMBOLS.has(sym) || EXCLUDE_WORDS.some(w => idName.includes(w))) continue;
      const variants = [[`${sym}USDT`, 1], [`1000${sym}USDT`, 1000], [`${sym}1000USDT`, 1000],
                        [`10000${sym}USDT`, 10000], [`1000000${sym}USDT`, 1e6]];
      for (const [raw, mult] of variants) {
        const t = byRaw.get(raw);
        if (!t) continue;
        const ratio = t.price / (c.current_price * mult);
        if (ratio > 0.9 && ratio < 1.1) out.push(t.symbol);
        break;
      }
      if (out.length >= n) break;
    }

    if (out.length >= n) {
      topMcCache = { symbols: out, fetchedAt: Date.now() };
      console.log(`[MarketCap] Top ${n} cripto com perpétuo: ${out.map(s => s.split('/')[0]).join(', ')}`);
    } else {
      console.warn(`[MarketCap] Top cripto incompleto (${out.length}/${n}) — mantém a lista anterior`);
    }
  } catch (err) {
    console.warn(`[MarketCap] Falha ao obter top cripto: ${err.message} — mantém a lista anterior`);
  }
  return topMcCache.symbols.slice(0, n);
}

module.exports = { fetchMarketCaps, fetchTopCryptoPerps };
