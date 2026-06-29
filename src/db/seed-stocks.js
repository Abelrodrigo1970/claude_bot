require('dotenv').config();
const { Pool } = require('pg');
const ccxt = require('ccxt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Lista fornecida pelo utilizador (formato Bybit raw: XYZUSDT)
const RAW_SYMBOLS = [
  'AAOIUSDT','AAPLUSDT','ADBEUSDT','ALABUSDT','AMATUSDT','AMDSTOCKUSDT',
  'AMZNUSDT','ARMUSDT','ASMLUSDT','ASTSUSDT','AVGOUSDT','AXTIUSDT',
  'BABAUSDT','BBXUSDT','BEUSDT','BMNRUSDT','CBRSUSDT','CIENUSDT',
  'COHRUSDT','COINUSDT','CRCLUSDT','CRDOUSDT','CRWVUSDT','CSCOUSDT',
  'DELLUSDT','DRAMUSDT','EWJUSDT','EWTUSDT','EWYUSDT','FLNCUSDT',
  'GLWUSDT','GOOGLUSDT','HOODUSDT','HPEUSDT','HYUNDAIUSDT','IBMUSDT',
  'INTCUSDT','IRENUSDT','IWMUSDT','KLACUSDT','KORUUSDT','LITEUSDT',
  'LLYUSDT','LRCXUSDT','METAUSDT','MRVLUSDT','MSFTUSDT','MSTRUSDT',
  'MUUSDT','NBISUSDT','NOKIAUSDT','NOWUSDT','NVDAUSDT','ONDSUSDT',
  'ORCLUSDT','PLTRUSDT','QCOMUSDT','QNTXUSDT','QQQUSDT','RKLBUSDT',
  'SAMSUNGUSDT','SKHYNIXUSDT','SMCIUSDT','SNDKUSDT','SOXLUSDT','SPCXUSDT',
  'SPYUSDT','STXXUSDT','TQQQUSDT','TSLAUSDT','TSMUSDT','USARUSDT',
  'UVXYUSDT','WDCUSDT',
];

// Categorias para classificação automática
const CATEGORY_MAP = {
  etf:       ['QQQ','SPY','SOXL','TQQQ','UVXY','IWM','EWJ','EWY','EWT','SPCX'],
  index:     ['SPX','ES','NDX'],
  metal:     ['XAU','XAG'],
  commodity: ['CORN','OIL','WTI'],
};

function getCategory(ticker) {
  for (const [cat, tickers] of Object.entries(CATEGORY_MAP)) {
    if (tickers.includes(ticker)) return cat;
  }
  return 'stock';
}

// Converte AAPLUSDT → { ticker: 'AAPL', symbol: 'AAPL/USDT:USDT' }
function parseRaw(raw) {
  const ticker = raw.replace(/USDT$/, '');
  const symbol = `${ticker}/USDT:USDT`;
  return { ticker, symbol };
}

async function main() {
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  console.log('📡 A carregar mercados da Bybit...');
  const markets = await exchange.loadMarkets();
  const availableSymbols = new Set(Object.keys(markets));

  const valid   = [];
  const missing = [];

  for (const raw of RAW_SYMBOLS) {
    const { ticker, symbol } = parseRaw(raw);
    if (availableSymbols.has(symbol)) {
      valid.push({ ticker, symbol, category: getCategory(ticker) });
    } else {
      missing.push({ raw, ticker, symbol });
    }
  }

  console.log(`\n✅ Encontrados na Bybit: ${valid.length}`);
  console.log(`❌ Não encontrados: ${missing.length}`);
  if (missing.length) {
    console.log('   ' + missing.map(m => m.ticker).join(', '));
  }

  // Insere na BD
  const client = await pool.connect();
  try {
    let inserted = 0, skipped = 0;
    for (const { ticker, symbol, category } of valid) {
      const res = await client.query(
        `INSERT INTO stock_symbols (symbol, ticker, category)
         VALUES ($1, $2, $3)
         ON CONFLICT (symbol) DO NOTHING`,
        [symbol, ticker, category]
      );
      if (res.rowCount > 0) inserted++;
      else skipped++;
    }
    console.log(`\n💾 BD: ${inserted} inseridos · ${skipped} já existiam`);

    // Mostrar tabela final
    const { rows } = await client.query(
      `SELECT ticker, category, symbol FROM stock_symbols WHERE active=true ORDER BY category, ticker`
    );
    console.log(`\n📋 Stock symbols na BD (${rows.length} total):`);
    let lastCat = '';
    rows.forEach(r => {
      if (r.category !== lastCat) { console.log(`\n  [${r.category.toUpperCase()}]`); lastCat = r.category; }
      console.log(`    ${r.ticker.padEnd(12)} ${r.symbol}`);
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
