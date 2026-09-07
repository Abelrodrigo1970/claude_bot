// Estudo pedido pelo utilizador (06/09/2026): quais os perpétuos USDT cripto
// da Bybit MAIS VOLÁTEIS nos últimos 90 dias — top 20.
//
// Métricas por par (velas diárias, 90 dias):
//   - volAnual: desvio-padrão dos retornos log diários × √365 (%), a medida
//     "canónica" de volatilidade realizada
//   - rangeDiário: média de (max-min)/fecho por dia (%)
//   - atr14%: ATR(14) mais recente / preço (%)
//   - maxDD: maior queda pico→vale sobre o fecho, dentro da janela (%)
//   - subidaMax: maior subida vale→pico corrida (%)
//   - varInícioFim: fecho[fim]/fecho[início]-1 (%)
//   - turnover24h: volume em USDT das últimas 24h (liquidez, via ticker)
//
// Duas tabelas: (A) top 20 filtrado a pares líquidos (turnover 24h >= 5M USDT
// — para dar uma lista negociável) e (B) top 20 bruto (sem filtro de liquidez,
// costuma ser dominado por moedas quase mortas com saltos de baixo volume).
// Stocks/ETFs tokenizados são excluídos (o utilizador pediu "criptos").
//
// Corre com: node src/backtests/study-90d-volatility.js [dias] [minTurnoverM]
const ccxt = require('ccxt');
const { ATR } = require('technicalindicators');

const DAYS = parseInt(process.argv[2] || '90', 10);
const MIN_TURNOVER = parseFloat(process.argv[3] || '5') * 1e6; // filtro de liquidez (default 5M USDT/24h)
const CONCURRENCY = 15;
const TOP_N = 20;

// Stocks/ETFs tokenizados na Bybit (ver src/db/seed-stocks.js) — fora do estudo
const STOCK_TICKERS = new Set([
  'AAOI','AAPL','ADBE','ALAB','AMAT','AMDSTOCK','AMZN','ARM','ASML','ASTS','AVGO','AXTI',
  'BABA','BBX','BE','BMNR','CBRS','CIEN','COHR','COIN','CRCL','CRDO','CRWV','CSCO',
  'DELL','DRAM','EWJ','EWT','EWY','FLNC','GLW','GOOGL','HOOD','HPE','HYUNDAI','IBM',
  'INTC','IREN','IWM','KLAC','KORU','LITE','LLY','LRCX','META','MRVL','MSFT','MSTR',
  'MU','NBIS','NOKIA','NOW','NVDA','ONDS','ORCL','PLTR','QCOM','QNTX','QQQ','RKLB',
  'SAMSUNG','SKHYNIX','SMCI','SNDK','SOXL','SPCX','SPY','STXX','TQQQ','TSLA','TSM',
  'USAR','UVXY','WDC',
]);

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) { const cur = idx++; results[cur] = await fn(items[cur], cur); }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function stddev(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados da Bybit...');
  const markets = await exchange.loadMarkets();
  const perps = Object.values(markets).filter(m =>
    m.linear && m.type === 'swap' && m.settle === 'USDT' && m.active &&
    !m.symbol.includes('USDC') && !STOCK_TICKERS.has(m.symbol.split('/')[0])
  );
  console.log(`${perps.length} perpétuos USDT cripto ativos.`);

  console.log('A obter tickers (turnover 24h)...');
  let tickers = {};
  try { tickers = await exchange.fetchTickers(perps.map(m => m.symbol)); } catch (e) { console.warn('fetchTickers falhou:', e.message); }

  console.log(`A obter ${DAYS} dias de velas diárias (${perps.length} pares, concorrência ${CONCURRENCY})...\n`);
  let done = 0;
  const rows = await mapLimit(perps, CONCURRENCY, async (m) => {
    try {
      const ohlcv = await exchange.fetchOHLCV(m.symbol, '1d', undefined, DAYS + 2);
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${perps.length}`);
      if (ohlcv.length < 30) return null;

      const c = ohlcv.slice(-DAYS).map(([t, o, h, l, cl, v]) => ({ t, o, h, l, c: cl, v }));
      const closes = c.map(x => x.c);

      const logRet = [];
      for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) logRet.push(Math.log(closes[i] / closes[i - 1]));
      const volDaily = stddev(logRet);
      const volAnnual = volDaily * Math.sqrt(365) * 100;

      const rangePct = c.map(x => x.c > 0 ? ((x.h - x.l) / x.c) * 100 : 0);
      const avgRange = rangePct.reduce((a, b) => a + b, 0) / rangePct.length;

      let atr14Pct = null;
      if (c.length >= 15) {
        const atr = ATR.calculate({ period: 14, high: c.map(x => x.h), low: c.map(x => x.l), close: closes });
        const lastAtr = atr[atr.length - 1];
        if (lastAtr != null && closes[closes.length - 1] > 0) atr14Pct = (lastAtr / closes[closes.length - 1]) * 100;
      }

      // maxDD pico→vale sobre o fecho
      let peak = closes[0], maxDD = 0;
      for (const px of closes) { peak = Math.max(peak, px); maxDD = Math.min(maxDD, (px - peak) / peak); }

      // maior subida vale-corrido → pico
      let runMin = c[0].l, bestUp = 0;
      for (const x of c) { runMin = Math.min(runMin, x.l); bestUp = Math.max(bestUp, (x.h - runMin) / runMin); }

      const varIF = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;

      return {
        symbol: m.symbol.split('/')[0],
        volAnnual, avgRange, atr14Pct,
        maxDDpct: maxDD * 100, bestUpPct: bestUp * 100, varIF,
        turnover24h: tickers[m.symbol]?.quoteVolume ?? 0,
        price: closes[closes.length - 1],
        days: c.length,
      };
    } catch { done++; return null; }
  });

  const valid = rows.filter(Boolean);
  console.log(`\n${valid.length}/${perps.length} pares com dados válidos (>=30 velas).\n`);

  const fmtRow = r => ({
    symbol: r.symbol,
    'volAnual%': r.volAnnual.toFixed(0),
    'rangeDia%': r.avgRange.toFixed(1),
    'atr14%': r.atr14Pct != null ? r.atr14Pct.toFixed(1) : '-',
    'maxDD%': r.maxDDpct.toFixed(0),
    'subidaMax%': '+' + r.bestUpPct.toFixed(0),
    'varInicioFim%': (r.varIF >= 0 ? '+' : '') + r.varIF.toFixed(0),
    'turnover24h': (r.turnover24h / 1e6).toFixed(1) + 'M',
  });

  const liquid = valid.filter(r => r.turnover24h >= MIN_TURNOVER).sort((a, b) => b.volAnnual - a.volAnnual);
  console.log('════════════════════════════════════════════════════════');
  console.log(`A) TOP ${TOP_N} MAIS VOLÁTEIS — ${DAYS}d — pares líquidos (turnover 24h >= ${(MIN_TURNOVER / 1e6).toFixed(0)}M USDT) · ${liquid.length} candidatos`);
  console.log('   ordenado por volatilidade anualizada dos retornos diários');
  console.log('════════════════════════════════════════════════════════');
  console.table(liquid.slice(0, TOP_N).map(fmtRow));

  const raw = [...valid].sort((a, b) => b.volAnnual - a.volAnnual);
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`B) TOP ${TOP_N} MAIS VOLÁTEIS — ${DAYS}d — SEM filtro de liquidez (todos os ${valid.length} pares)`);
  console.log('════════════════════════════════════════════════════════');
  console.table(raw.slice(0, TOP_N).map(fmtRow));

  // top 20 por range diário médio (leitura alternativa de "volatilidade")
  const byRange = valid.filter(r => r.turnover24h >= MIN_TURNOVER).sort((a, b) => b.avgRange - a.avgRange);
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`C) TOP ${TOP_N} por AMPLITUDE DIÁRIA MÉDIA (max-min)/fecho — pares líquidos`);
  console.log('════════════════════════════════════════════════════════');
  console.table(byRange.slice(0, TOP_N).map(fmtRow));

  const fs = require('fs'); const path = require('path');
  const out = path.join(__dirname, 'data', 'study-90d-volatility-result.json');
  fs.writeFileSync(out, JSON.stringify({ params: { DAYS, MIN_TURNOVER }, generatedAt: new Date().toISOString(), all: raw }, null, 2));
  console.log(`\nJSON completo (${valid.length} pares): ${out}`);
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
