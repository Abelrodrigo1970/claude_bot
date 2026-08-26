// Estudo: quais criptos (perpétuos USDT na Bybit) tiveram uma variação
// acima de +200% nos últimos ~6 meses. Para cada par, calcula o maior
// "trough-to-peak" (comprou no mínimo, vendeu no máximo depois) dentro da
// janela, não só a variação início-fim (que ignora picos intermédios), mais
// a variação simples início-fim para contexto.
//
// Corre com: node src/backtests/study-6month-movers.js [minGainPct] [days]
const ccxt = require('ccxt');

const MIN_GAIN_PCT = parseFloat(process.argv[2] || '200');
const DAYS = parseInt(process.argv[3] || '182', 10);
const CONCURRENCY = 15;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('A carregar mercados...');
  const markets = await exchange.loadMarkets();
  const perps = Object.values(markets).filter(m =>
    m.linear && m.type === 'swap' && m.settle === 'USDT' && m.active && !m.symbol.includes('USDC')
  );
  console.log(`${perps.length} pares USDT-linear ativos — a obter ${DAYS} dias de candles diárias cada...\n`);

  let done = 0;
  const results = await mapLimit(perps, CONCURRENCY, async (m) => {
    try {
      const ohlcv = await exchange.fetchOHLCV(m.symbol, '1d', undefined, DAYS);
      done++;
      if (done % 50 === 0) console.log(`  progresso: ${done}/${perps.length}`);
      if (ohlcv.length < 10) return null;

      const candles = ohlcv.map(([t, o, h, l, c, v]) => ({ time: new Date(t), high: h, low: l, close: c }));
      const startPrice = candles[0].close;
      const endPrice = candles[candles.length - 1].close;
      const startTime = candles[0].time;
      const endTime = candles[candles.length - 1].time;

      // Maior subida "comprou no minimo corrido, vendeu no maximo depois"
      let runningMin = candles[0].low;
      let runningMinTime = candles[0].time;
      let bestGainPct = 0, bestLowPrice = candles[0].low, bestLowTime = candles[0].time, bestHighPrice = candles[0].high, bestHighTime = candles[0].time;
      for (const c of candles) {
        if (c.low < runningMin) { runningMin = c.low; runningMinTime = c.time; }
        const gainPct = ((c.high - runningMin) / runningMin) * 100;
        if (gainPct > bestGainPct) {
          bestGainPct = gainPct;
          bestLowPrice = runningMin;
          bestLowTime = runningMinTime;
          bestHighPrice = c.high;
          bestHighTime = c.time;
        }
      }

      const endToEndPct = ((endPrice - startPrice) / startPrice) * 100;

      return {
        symbol: m.symbol.split('/')[0],
        startPrice, endPrice, startTime, endTime,
        endToEndPct,
        bestGainPct, bestLowPrice, bestLowTime, bestHighPrice, bestHighTime,
        candleCount: candles.length,
      };
    } catch (err) {
      return null;
    }
  });

  const valid = results.filter(Boolean);
  console.log(`\n${valid.length}/${perps.length} pares com dados válidos.\n`);

  const movers = valid.filter(r => r.bestGainPct >= MIN_GAIN_PCT).sort((a, b) => b.bestGainPct - a.bestGainPct);
  console.log(`===== PARES COM SUBIDA (mínimo→máximo) >= +${MIN_GAIN_PCT}% NOS ÚLTIMOS ~${DAYS} DIAS =====`);
  console.log(`Encontrados: ${movers.length}\n`);
  console.table(movers.map(r => ({
    symbol: r.symbol,
    subidaMaxima: '+' + r.bestGainPct.toFixed(0) + '%',
    minimo: r.bestLowPrice,
    dataMinimo: r.bestLowTime.toISOString().slice(0, 10),
    maximo: r.bestHighPrice,
    dataMaximo: r.bestHighTime.toISOString().slice(0, 10),
    variacaoInicioFim: (r.endToEndPct >= 0 ? '+' : '') + r.endToEndPct.toFixed(0) + '%',
    devolveuDoTopo: (((r.endPrice - r.bestHighPrice) / r.bestHighPrice) * 100).toFixed(1) + '%',
  })));

  console.log(`\nTotal analisado: ${valid.length} pares · ${movers.length} (${((movers.length / valid.length) * 100).toFixed(1)}%) tiveram subida >= +${MIN_GAIN_PCT}%`);
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
