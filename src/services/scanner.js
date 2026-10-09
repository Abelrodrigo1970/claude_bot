const { EMA } = require('technicalindicators');
const bybit = require('./bybit');
const pool  = require('../db/pool');
const telegram = require('./telegram');

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 horas — alinhado com o ciclo do cron

// loadMarkets/fetchTickers abaixo usam bybit.publicExchange (sem
// apiKey/secret) — são leitura pública de mercado, nunca precisaram de
// conta, e assim ficam imunes a uma API key inválida/expirada em .env
// (essa só deve bloquear ordens/posições/saldo, que continuam via
// bybit.exchange). Ver bybit.js.

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
    const markets = await bybit.publicExchange.loadMarkets();

    const perps = Object.values(markets)
      .filter(m =>
        m.linear &&
        m.settle === 'USDT' &&
        m.active &&
        !m.symbol.includes('USDC')
      )
      .sort((a, b) => parseFloat(b.info.turnover24h || 0) - parseFloat(a.info.turnover24h || 0))
      .slice(0, 250);

    console.log(`[Scanner EMA${period}] ${perps.length} pares elegíveis — ex: ${perps.slice(0,3).map(m => m.symbol).join(', ')}`);

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
    const top = results.slice(0, limit);
    const scannedAt = new Date();

    states[period].results   = top;
    states[period].scannedAt = scannedAt.getTime();
    states[period].status    = 'done';

    // Guarda no histórico da BD (silencioso se BD não estiver configurada)
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < top.length; i++) {
          const r = top[i];
          await client.query(
            `INSERT INTO scanner_results (ema_period, rank, symbol, price, ema, pct_above, change_24h, volume, scanned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [period, i + 1, r.symbol, r.price, r.ema, r.pctAbove, r.change24h, r.volume, scannedAt]
          );
        }
        await client.query('COMMIT');
        console.log(`[Scanner] EMA${period}: ${top.length} resultados guardados na BD`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    states[period].status = 'error';
    states[period].error  = err.message;
  }
}

function getState(period = 200) {
  return states[period] || states[200];
}

// ─── SCANNER TOP GANHOS 24H ────────────────────────────────────
// Ranking simples por variação de preço nas últimas 24h (não usa EMA).
// Usa fetchTickers em lote — muito mais leve que os scanners EMA (1 pedido vs. ~250).

let gainersState = { status: 'idle', progress: 0, total: 0, results: [], previousResults: [], scannedAt: null, error: null };

async function startScanGainers(limit = 4) {
  if (gainersState.status === 'scanning') return;
  if (gainersState.status === 'done' && gainersState.scannedAt && Date.now() - gainersState.scannedAt < CACHE_TTL) return;

  // Guarda o Top N anterior antes de o sobrepor — usado pela Top4RotationFade
  // para detetar símbolos que acabaram de sair do ranking.
  const previousResults = gainersState.results;
  gainersState = { ...gainersState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.publicExchange.loadMarkets();

    // Nota: m.info.turnover24h não existe nos dados de loadMarkets() (só no ticker),
    // por isso não há como pré-filtrar por volume aqui sem primeiro pedir os tickers.
    // A Bybit também não filtra por volume no ecrã "TOP" — ordena todos os perpétuos por % 24h.
    const perps = Object.values(markets)
      .filter(m =>
        m.linear &&
        m.type === 'swap' && // exclui futuros datados — fetchTickers em lote exige o mesmo tipo
        m.settle === 'USDT' &&
        m.active &&
        !m.symbol.includes('USDC')
      );

    gainersState.total = perps.length;
    console.log(`[Scanner Top24h] ${perps.length} pares elegíveis`);

    const symbols = perps.map(m => m.symbol);
    const tickers = await bybit.publicExchange.fetchTickers(symbols);
    gainersState.progress = perps.length;

    const results = perps
      .map(m => {
        const t = tickers[m.symbol];
        if (!t || t.percentage == null || t.last == null) return null;
        return {
          symbol:    m.symbol,
          price:     t.last,
          change24h: t.percentage,
          volume:    t.quoteVolume ?? 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.change24h - a.change24h);

    const top = results.slice(0, limit);
    const scannedAt = new Date();

    gainersState.results         = top;
    gainersState.previousResults = previousResults;
    gainersState.scannedAt       = scannedAt.getTime();
    gainersState.status          = 'done';

    // Guarda no histórico da BD (silencioso se BD não estiver configurada)
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < top.length; i++) {
          const r = top[i];
          await client.query(
            `INSERT INTO scanner_gainers (rank, symbol, price, change_24h, volume, scanned_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [i + 1, r.symbol, r.price, r.change24h, r.volume, scannedAt]
          );
        }
        await client.query('COMMIT');
        console.log(`[Scanner Top24h] ${top.length} resultados guardados na BD`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner Top24h] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    gainersState.status = 'error';
    gainersState.error  = err.message;
  }
}

function getGainersState() {
  return gainersState;
}

// ─── SCANNER PUMP 24H (sem limite de top-N) ────────────────────
// Variante do scanner Top ganhos 24h acima: em vez de cortar a um Top N,
// devolve TODOS os pares com variação 24h acima de um limiar (10% por
// omissão) — pensado para apanhar qualquer par em "pump", não só os 4
// maiores. Mesma fonte de dados (fetchTickers em lote), sem EMA.

let pumpState = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

async function startScanPump(thresholdPct = 10) {
  if (pumpState.status === 'scanning') return;
  if (pumpState.status === 'done' && pumpState.scannedAt && Date.now() - pumpState.scannedAt < CACHE_TTL) return;

  pumpState = { ...pumpState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.publicExchange.loadMarkets();

    const perps = Object.values(markets)
      .filter(m =>
        m.linear &&
        m.type === 'swap' &&
        m.settle === 'USDT' &&
        m.active &&
        !m.symbol.includes('USDC')
      );

    pumpState.total = perps.length;
    console.log(`[Scanner Pump24h] ${perps.length} pares elegíveis — limiar ${thresholdPct}%`);

    const symbols = perps.map(m => m.symbol);
    const tickers = await bybit.publicExchange.fetchTickers(symbols);
    pumpState.progress = perps.length;

    const results = perps
      .map(m => {
        const t = tickers[m.symbol];
        if (!t || t.percentage == null || t.last == null) return null;
        return {
          symbol:    m.symbol,
          price:     t.last,
          change24h: t.percentage,
          volume:    t.quoteVolume ?? 0,
        };
      })
      .filter(Boolean)
      .filter(r => r.change24h >= thresholdPct)
      .sort((a, b) => b.change24h - a.change24h);

    const scannedAt = new Date();

    pumpState.results   = results; // sem slice — todos os que passam o limiar
    pumpState.scannedAt = scannedAt.getTime();
    pumpState.status    = 'done';
    console.log(`[Scanner Pump24h] ${results.length} pares acima de +${thresholdPct}%`);

    // Guarda no histórico da BD (silencioso se BD não estiver configurada)
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          await client.query(
            `INSERT INTO scanner_pump (rank, symbol, price, change_24h, volume, scanned_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [i + 1, r.symbol, r.price, r.change24h, r.volume, scannedAt]
          );
        }
        await client.query('COMMIT');
        console.log(`[Scanner Pump24h] ${results.length} resultados guardados na BD`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner Pump24h] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    pumpState.status = 'error';
    pumpState.error  = err.message;
  }
}

function getPumpState() {
  return pumpState;
}

// ─── SCANNER EMA TREND (21/50, diário + 1h) ────────────────────
// Só entram os pares em que o preço está acima da EMA21 E da EMA50,
// tanto no diário como no 1h — 4 condições simultâneas.

let emaTrendState = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

async function startScanEmaTrend(limit = 50) {
  if (emaTrendState.status === 'scanning') return;
  if (emaTrendState.status === 'done' && emaTrendState.scannedAt && Date.now() - emaTrendState.scannedAt < CACHE_TTL) return;

  emaTrendState = { ...emaTrendState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.publicExchange.loadMarkets();

    const perps = Object.values(markets).filter(m =>
      m.linear &&
      m.type === 'swap' &&
      m.settle === 'USDT' &&
      m.active &&
      !m.symbol.includes('USDC')
    );

    // Ordena pelos pares com mais volume real (via ticker, loadMarkets não tem turnover24h)
    let ranked = perps;
    try {
      const tickers = await bybit.publicExchange.fetchTickers(perps.map(m => m.symbol));
      ranked = perps
        .map(m => ({ market: m, volume: tickers[m.symbol]?.quoteVolume || 0, change24h: tickers[m.symbol]?.percentage ?? null }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 250);
    } catch {
      ranked = perps.slice(0, 250).map(m => ({ market: m, volume: 0, change24h: null }));
    }

    console.log(`[Scanner EMATrend] ${ranked.length} pares elegíveis (top volume)`);
    emaTrendState.total = ranked.length;

    const needed = 50 + 10;
    const results = [];

    for (let i = 0; i < ranked.length; i++) {
      emaTrendState.progress = i + 1;
      const { market, volume, change24h } = ranked[i];

      try {
        const [daily, hourly] = await Promise.all([
          bybit.getCandles(market.symbol, '1d', needed + 5),
          bybit.getCandles(market.symbol, '1h', needed + 5),
        ]);
        if (daily.length < needed || hourly.length < needed) continue;

        const closesD = daily.map(c => c.close);
        const closesH = hourly.map(c => c.close);

        const ema21D = EMA.calculate({ period: 21, values: closesD }).at(-1);
        const ema50D = EMA.calculate({ period: 50, values: closesD }).at(-1);
        const ema21H = EMA.calculate({ period: 21, values: closesH }).at(-1);
        const ema50H = EMA.calculate({ period: 50, values: closesH }).at(-1);

        const price = closesH[closesH.length - 1];

        const passes = price > ema21D && price > ema50D && price > ema21H && price > ema50H;
        if (!passes) continue;

        const pctAbove = ((price - ema21D) / ema21D + (price - ema50D) / ema50D +
                           (price - ema21H) / ema21H + (price - ema50H) / ema50H) / 4 * 100;

        results.push({
          symbol: market.symbol,
          price,
          ema21_1d: ema21D,
          ema50_1d: ema50D,
          ema21_1h: ema21H,
          ema50_1h: ema50H,
          pctAbove,
          change24h,
          volume,
        });
      } catch {
        // par sem dados suficientes, ignorar
      }
    }

    results.sort((a, b) => b.pctAbove - a.pctAbove);
    const top = results.slice(0, limit);
    const scannedAt = new Date();

    emaTrendState.results   = top;
    emaTrendState.scannedAt = scannedAt.getTime();
    emaTrendState.status    = 'done';

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < top.length; i++) {
          const r = top[i];
          await client.query(
            `INSERT INTO scanner_ema_trend (rank, symbol, price, ema21_1d, ema50_1d, ema21_1h, ema50_1h, pct_above, change_24h, volume, scanned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [i + 1, r.symbol, r.price, r.ema21_1d, r.ema50_1d, r.ema21_1h, r.ema50_1h, r.pctAbove, r.change24h, r.volume, scannedAt]
          );
        }
        await client.query('COMMIT');
        console.log(`[Scanner EMATrend] ${top.length} resultados guardados na BD`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner EMATrend] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    emaTrendState.status = 'error';
    emaTrendState.error  = err.message;
  }
}

function getEmaTrendState() {
  return emaTrendState;
}

// ─── SCANNER EMA TREND STOCKS (21/50, diário + 1h) ─────────────
// Igual ao EMA Trend acima, mas sobre o universo de stocks/ETFs
// (tabela stock_symbols) em vez do top 250 de perpétuos por volume.

let emaTrendStocksState = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

async function startScanEmaTrendStocks(limit = 50) {
  if (emaTrendStocksState.status === 'scanning') return;
  if (emaTrendStocksState.status === 'done' && emaTrendStocksState.scannedAt && Date.now() - emaTrendStocksState.scannedAt < CACHE_TTL) return;

  emaTrendStocksState = { ...emaTrendStocksState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const { rows: stockRows } = await pool.query('SELECT symbol FROM stock_symbols WHERE active=true ORDER BY ticker');
    const symbols = stockRows.map(r => r.symbol);

    let tickers = {};
    try {
      tickers = await bybit.publicExchange.fetchTickers(symbols);
    } catch {
      // segue sem change24h/volume se o fetch em lote falhar
    }

    console.log(`[Scanner EMATrend Stocks] ${symbols.length} stocks/ETFs elegíveis`);
    emaTrendStocksState.total = symbols.length;

    const needed = 50 + 10;
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
      emaTrendStocksState.progress = i + 1;
      const symbol = symbols[i];

      try {
        const [daily, hourly] = await Promise.all([
          bybit.getCandles(symbol, '1d', needed + 5),
          bybit.getCandles(symbol, '1h', needed + 5),
        ]);
        if (daily.length < needed || hourly.length < needed) continue;

        const closesD = daily.map(c => c.close);
        const closesH = hourly.map(c => c.close);

        const ema21D = EMA.calculate({ period: 21, values: closesD }).at(-1);
        const ema50D = EMA.calculate({ period: 50, values: closesD }).at(-1);
        const ema21H = EMA.calculate({ period: 21, values: closesH }).at(-1);
        const ema50H = EMA.calculate({ period: 50, values: closesH }).at(-1);

        const price = closesH[closesH.length - 1];

        const passes = price > ema21D && price > ema50D && price > ema21H && price > ema50H;
        if (!passes) continue;

        const pctAbove = ((price - ema21D) / ema21D + (price - ema50D) / ema50D +
                           (price - ema21H) / ema21H + (price - ema50H) / ema50H) / 4 * 100;

        results.push({
          symbol,
          price,
          ema21_1d: ema21D,
          ema50_1d: ema50D,
          ema21_1h: ema21H,
          ema50_1h: ema50H,
          pctAbove,
          change24h: tickers[symbol]?.percentage ?? null,
          volume: tickers[symbol]?.quoteVolume ?? 0,
        });
      } catch {
        // simbolo sem dados suficientes, ignorar
      }
    }

    results.sort((a, b) => b.pctAbove - a.pctAbove);
    const top = results.slice(0, limit);
    const scannedAt = new Date();

    emaTrendStocksState.results   = top;
    emaTrendStocksState.scannedAt = scannedAt.getTime();
    emaTrendStocksState.status    = 'done';

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < top.length; i++) {
          const r = top[i];
          await client.query(
            `INSERT INTO scanner_ema_trend_stocks (rank, symbol, price, ema21_1d, ema50_1d, ema21_1h, ema50_1h, pct_above, change_24h, volume, scanned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [i + 1, r.symbol, r.price, r.ema21_1d, r.ema50_1d, r.ema21_1h, r.ema50_1h, r.pctAbove, r.change24h, r.volume, scannedAt]
          );
        }
        await client.query('COMMIT');
        console.log(`[Scanner EMATrend Stocks] ${top.length} resultados guardados na BD`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner EMATrend Stocks] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    emaTrendStocksState.status = 'error';
    emaTrendStocksState.error  = err.message;
  }
}

function getEmaTrendStocksState() {
  return emaTrendStocksState;
}

// ─── SCANNER EMA TREND TOTAL (sem limite de top-N) ─────────────
// Igual ao EMA Trend acima (preço > EMA21 e > EMA50, diário e 1h), mas
// devolve TODOS os símbolos que passam o filtro, sem cortar a um top-N —
// é o universo "sem limite" usado no estudo da PullbackTrend (ver
// src/backtests/backtest-pullbackTrend-emaTrend.js). Estado próprio,
// separado do emaTrendState (top-N) acima, para não pisar a cache
// partilhada com o painel do Scanner na UI. Não persiste em BD — não tem
// painel de histórico próprio, é só para o runner resolver símbolos.
let emaTrendTotalState = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

async function startScanEmaTrendTotal() {
  if (emaTrendTotalState.status === 'scanning') return;
  if (emaTrendTotalState.status === 'done' && emaTrendTotalState.scannedAt && Date.now() - emaTrendTotalState.scannedAt < CACHE_TTL) return;

  emaTrendTotalState = { ...emaTrendTotalState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.publicExchange.loadMarkets();

    const perps = Object.values(markets).filter(m =>
      m.linear &&
      m.type === 'swap' &&
      m.settle === 'USDT' &&
      m.active &&
      !m.symbol.includes('USDC')
    );

    let ranked = perps;
    try {
      const tickers = await bybit.publicExchange.fetchTickers(perps.map(m => m.symbol));
      ranked = perps
        .map(m => ({ market: m, volume: tickers[m.symbol]?.quoteVolume || 0, change24h: tickers[m.symbol]?.percentage ?? null }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 250);
    } catch {
      ranked = perps.slice(0, 250).map(m => ({ market: m, volume: 0, change24h: null }));
    }

    console.log(`[Scanner EMATrend Total] ${ranked.length} pares elegíveis (top volume)`);
    emaTrendTotalState.total = ranked.length;

    const needed = 50 + 10;
    const results = [];

    for (let i = 0; i < ranked.length; i++) {
      emaTrendTotalState.progress = i + 1;
      const { market, volume, change24h } = ranked[i];

      try {
        const [daily, hourly] = await Promise.all([
          bybit.getCandles(market.symbol, '1d', needed + 5),
          bybit.getCandles(market.symbol, '1h', needed + 5),
        ]);
        if (daily.length < needed || hourly.length < needed) continue;

        const closesD = daily.map(c => c.close);
        const closesH = hourly.map(c => c.close);

        const ema21D = EMA.calculate({ period: 21, values: closesD }).at(-1);
        const ema50D = EMA.calculate({ period: 50, values: closesD }).at(-1);
        const ema21H = EMA.calculate({ period: 21, values: closesH }).at(-1);
        const ema50H = EMA.calculate({ period: 50, values: closesH }).at(-1);

        const price = closesH[closesH.length - 1];

        const passes = price > ema21D && price > ema50D && price > ema21H && price > ema50H;
        if (!passes) continue;

        const pctAbove = ((price - ema21D) / ema21D + (price - ema50D) / ema50D +
                           (price - ema21H) / ema21H + (price - ema50H) / ema50H) / 4 * 100;

        results.push({
          symbol: market.symbol,
          price,
          ema21_1d: ema21D,
          ema50_1d: ema50D,
          ema21_1h: ema21H,
          ema50_1h: ema50H,
          pctAbove,
          change24h,
          volume,
        });
      } catch {
        // par sem dados suficientes, ignorar
      }
    }

    results.sort((a, b) => b.pctAbove - a.pctAbove);

    emaTrendTotalState.results   = results; // sem slice — todos os que passam o filtro
    emaTrendTotalState.scannedAt = Date.now();
    emaTrendTotalState.status    = 'done';
    console.log(`[Scanner EMATrend Total] ${results.length} pares elegíveis (sem limite)`);
  } catch (err) {
    emaTrendTotalState.status = 'error';
    emaTrendTotalState.error  = err.message;
    console.warn(`[Scanner EMATrend Total] Erro: ${err.message}`);
  }
}

function getEmaTrendTotalState() {
  return emaTrendTotalState;
}

// ─── SCANNER LISTA 50 (spike de volume, 15m) ───────────────────
// Universo FIXO: os 50 símbolos de src/backtests/data/top50-6month-movers.json
// (maiores subidas dos últimos 6 meses, já em queda de mais de 40% do pico —
// ver o estudo de fade nesse ficheiro). Pedido pelo utilizador (27/08) para
// vigiar se algum deles volta a mexer-se com força: deteta "spike" numa vela
// de 15m já fechada quando o volume é >= 5x a média das 10 velas anteriores
// E o fecho é acima da abertura (confirma subida, não só volume).
//
// Cache mais curta que os outros scanners (10min, não 2h) porque este corre
// a cada 15min via cron — precisa de refrescar a cada candle nova.
//
// Filtro de apresentação (03/09, pedido do utilizador): só entram na lista
// os símbolos com preço acima da SMA(50) das velas de 15m E volume da vela
// atual > 1x a média das 10 velas anteriores — o "spike" (5x) continua a
// ser só um destaque (isSpike) dentro deste subconjunto já filtrado, não o
// critério de entrada na lista. Cada resultado traz também o preço da
// sessão de scan anterior (previousPrice), para ver a variação entre scans
// consecutivos de 15min, não só dentro da própria vela.
const VOLATILE50_SYMBOLS = require('../backtests/data/top50-6month-movers.json').movers.map(m => m.symbol);
const VOLATILE50_SPIKE_RATIO = 5;
const VOLATILE50_MA_PERIOD = 50;
const VOLATILE50_CANDLES_NEEDED = VOLATILE50_MA_PERIOD + 6; // 50 p/ SMA + 10 p/ média de volume (sobrepõe-se) + folga + vela em formação

// Factory — mesma lógica do scanner Lista 50, parametrizada por timeframe
// (03/09, pedido do utilizador: versão em 4h além da original de 15m).
// tableName tem de bater com uma tabela já criada em db/migrate.js, com o
// mesmo esquema de scanner_volatile50.
function createVolatile50Scanner({ timeframe, tableName, cacheTtl, label }) {
  let state = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

  async function startScan() {
    if (state.status === 'scanning') return;
    if (state.status === 'done' && state.scannedAt && Date.now() - state.scannedAt < cacheTtl) return;

    // Preços da sessão de scan anterior (antes de sobrescrever results) —
    // usados para a coluna "preço anterior" / variação entre scans.
    const previousBySymbol = new Map(state.results.map(r => [r.symbol, r.price]));

    state = { ...state, status: 'scanning', progress: 0, total: VOLATILE50_SYMBOLS.length, results: [], error: null };

    try {
      const results = [];

      for (let i = 0; i < VOLATILE50_SYMBOLS.length; i++) {
        state.progress = i + 1;
        const symbol = VOLATILE50_SYMBOLS[i];

        try {
          // VOLATILE50_CANDLES_NEEDED velas: as 50 fechadas mais recentes
          // (p/ SMA50) + folga + a vela em formação (última, descartada).
          const candles = await bybit.getCandles(symbol, timeframe, VOLATILE50_CANDLES_NEEDED);
          const closed = candles.slice(0, -1); // remove a vela ainda em formação
          if (closed.length < VOLATILE50_MA_PERIOD) continue;

          const current = closed[closed.length - 1];
          const prior   = closed.slice(closed.length - 11, closed.length - 1);
          const last50  = closed.slice(closed.length - VOLATILE50_MA_PERIOD);
          if (!current || prior.length < 10) continue;

          const avgVolume10 = prior.reduce((a, c) => a + c.volume, 0) / prior.length;
          const volumeRatio = avgVolume10 > 0 ? current.volume / avgVolume10 : 0;
          const changePct   = current.open > 0 ? ((current.close - current.open) / current.open) * 100 : 0;
          const isSpike     = volumeRatio >= VOLATILE50_SPIKE_RATIO && current.close > current.open;

          const sma50     = last50.reduce((a, c) => a + c.close, 0) / last50.length;
          const aboveMA50 = current.close > sma50;

          // Só entram na lista os símbolos acima da SMA50 e com volume >1x a
          // média das 10 velas anteriores (pedido do utilizador, 03/09) — o
          // spike de 5x continua a ser só um destaque dentro deste subconjunto.
          if (!aboveMA50 || volumeRatio <= 1) continue;

          const previousPrice     = previousBySymbol.get(symbol) ?? null;
          const prevScanChangePct = previousPrice ? ((current.close - previousPrice) / previousPrice) * 100 : null;

          results.push({
            symbol,
            price: current.close,
            previousPrice,
            prevScanChangePct,
            changePct,
            volume: current.volume,
            avgVolume10,
            volumeRatio,
            sma50,
            isSpike,
            candleTime: current.time,
          });
        } catch {
          // símbolo sem dados suficientes no momento, ignora
        }
      }

      results.sort((a, b) => b.volumeRatio - a.volumeRatio);

      const scannedAt = new Date();
      state.results   = results;
      state.scannedAt = scannedAt.getTime();
      state.status    = 'done';
      const spikeResults = results.filter(r => r.isSpike);
      console.log(`[Scanner ${label}] ${spikeResults.length} spike(s) de volume em ${results.length}/${VOLATILE50_SYMBOLS.length} símbolos`);

      if (spikeResults.length) {
        const lines = spikeResults.map(r =>
          `<b>${r.symbol.split('/')[0]}</b> +${r.changePct.toFixed(1)}% na vela · volume ${r.volumeRatio.toFixed(1)}x a média · preço ${r.price}`
        );
        const msg = `🔥 <b>Spike na ${label}</b> (vela de ${timeframe})\n\n${lines.join('\n')}`;
        telegram.sendMessage(msg); // não bloqueia o scan — falha de envio é só um warning na consola
      }

      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            await client.query(
              `INSERT INTO ${tableName} (rank, symbol, price, previous_price, prev_scan_change_pct, change_pct, volume, avg_volume_10, volume_ratio, sma50, is_spike, candle_time, scanned_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [i + 1, r.symbol, r.price, r.previousPrice, r.prevScanChangePct, r.changePct, r.volume, r.avgVolume10, r.volumeRatio, r.sma50, r.isSpike, r.candleTime, scannedAt]
            );
          }
          await client.query('COMMIT');
        } catch (dbErr) {
          await client.query('ROLLBACK');
          console.warn(`[Scanner ${label}] Erro ao guardar no BD:`, dbErr.message);
        } finally {
          client.release();
        }
      } catch {
        // BD não configurada — continua sem guardar
      }
    } catch (err) {
      state.status = 'error';
      state.error  = err.message;
    }
  }

  function getState() { return state; }

  return { startScan, getState, tableName };
}

// 15m: cache curta (10min) porque corre a cada 15min via cron.
const volatile50Scanner15m = createVolatile50Scanner({
  timeframe: '15m', tableName: 'scanner_volatile50', cacheTtl: 10 * 60 * 1000, label: 'Lista50 15m',
});
// 4h: cache de ~3h55min (não os 4h exatos, para não ficar "à justa" com o
// atraso do cron) — a vela só fecha a cada 4h, e o cron (ver server.js)
// corre alinhado com esses fechos (00h/04h/08h/12h/16h/20h UTC), não de
// hora a hora.
const volatile50Scanner4h = createVolatile50Scanner({
  timeframe: '4h', tableName: 'scanner_volatile50_4h', cacheTtl: 235 * 60 * 1000, label: 'Lista50 4h',
});

async function startScanVolatile50() { return volatile50Scanner15m.startScan(); }
function getVolatile50State() { return volatile50Scanner15m.getState(); }
async function startScanVolatile50_4h() { return volatile50Scanner4h.startScan(); }
function getVolatile50State4h() { return volatile50Scanner4h.getState(); }

// ─── SCANNER TOP GANHOS — SEMANA / MÊS CORRENTE ────────────────
// Duas listas (Top 50 semana corrente e Top 50 mês corrente), calculadas
// numa só passagem sobre os pares elegíveis — filtro prévio por market cap
// (via CoinGecko, > 90M USD) para não gastar pedidos à Bybit com moedas
// pequenas. "Semana"/"mês corrente" = desde a última 2ª feira / desde o
// dia 1, UTC — não é uma janela rolling de 7/30 dias.
const marketcap = require('./marketcap');
const PERIOD_GAINERS_MIN_MARKET_CAP = 90_000_000;
const PERIOD_GAINERS_CANDLES = 40; // cobre o pior caso (mês com 31 dias) + folga + vela em formação

function startOfUTCWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=domingo
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1) - day);
  return d;
}
function startOfUTCMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

let periodGainersState = {
  status: 'idle', progress: 0, total: 0,
  resultsWeek: [], resultsMonth: [], scannedAt: null, error: null,
};

async function startScanPeriodGainers(limit = 50) {
  if (periodGainersState.status === 'scanning') return;
  if (periodGainersState.status === 'done' && periodGainersState.scannedAt && Date.now() - periodGainersState.scannedAt < CACHE_TTL) return;

  periodGainersState = { ...periodGainersState, status: 'scanning', progress: 0, total: 0, resultsWeek: [], resultsMonth: [], error: null };

  try {
    const marketCaps = await marketcap.fetchMarketCaps();

    const markets = await bybit.publicExchange.loadMarkets();
    const perps = Object.values(markets).filter(m =>
      m.linear &&
      m.type === 'swap' &&
      m.settle === 'USDT' &&
      m.active &&
      !m.symbol.includes('USDC')
    );

    // Filtro por market cap ANTES de pedir velas — poupa centenas de pedidos à Bybit.
    const eligible = perps.filter(m => {
      const cap = m.base ? marketCaps.get(m.base.toUpperCase()) : null;
      return cap != null && cap > PERIOD_GAINERS_MIN_MARKET_CAP;
    });

    console.log(`[Scanner TopGainers] ${eligible.length}/${perps.length} pares com market cap > 90M`);
    periodGainersState.total = eligible.length;

    const now = new Date();
    const weekStart  = startOfUTCWeek(now);
    const monthStart = startOfUTCMonth(now);
    const results = [];

    for (let i = 0; i < eligible.length; i++) {
      periodGainersState.progress = i + 1;
      const market = eligible[i];

      try {
        const [daily, hourly] = await Promise.all([
          bybit.getCandles(market.symbol, '1d', PERIOD_GAINERS_CANDLES),
          bybit.getCandles(market.symbol, '1h', 2),
        ]);
        if (daily.length < 8) continue;

        const current = daily[daily.length - 1]; // vela de hoje (em formação) — close = preço atual
        const price   = current.close;
        const prevDay = daily[daily.length - 2];

        // Última vela fechada ANTES do início da semana/mês corrente — baseline da variação.
        const weekBase  = [...daily].reverse().find(c => c.time < weekStart);
        const monthBase = [...daily].reverse().find(c => c.time < monthStart);

        const change24h = prevDay   ? ((price - prevDay.close)   / prevDay.close)   * 100 : null;
        const change7d  = weekBase  ? ((price - weekBase.close)  / weekBase.close)  * 100 : null;
        const change30d = monthBase ? ((price - monthBase.close) / monthBase.close) * 100 : null;
        const change1h  = hourly.length >= 2 ? ((hourly[1].close - hourly[0].close) / hourly[0].close) * 100 : null;

        if (change7d == null && change30d == null) continue; // sem histórico suficiente p/ nenhuma das duas listas

        results.push({
          symbol:    market.symbol,
          price,
          marketCap: marketCaps.get(market.base.toUpperCase()),
          change1h, change24h, change7d, change30d,
          volume: current.volume * price,
        });
      } catch {
        // par sem dados suficientes, ignora
      }
    }

    const resultsWeek  = results.filter(r => r.change7d  != null).sort((a, b) => b.change7d  - a.change7d).slice(0, limit);
    const resultsMonth = results.filter(r => r.change30d != null).sort((a, b) => b.change30d - a.change30d).slice(0, limit);
    const scannedAt = new Date();

    periodGainersState.resultsWeek  = resultsWeek;
    periodGainersState.resultsMonth = resultsMonth;
    periodGainersState.scannedAt    = scannedAt.getTime();
    periodGainersState.status       = 'done';
    console.log(`[Scanner TopGainers] semana: ${resultsWeek.length} · mês: ${resultsMonth.length}`);

    // Guarda no histórico da BD (silencioso se BD não estiver configurada)
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [period, list] of [['week', resultsWeek], ['month', resultsMonth]]) {
          for (let i = 0; i < list.length; i++) {
            const r = list[i];
            await client.query(
              `INSERT INTO scanner_period_gainers (period, rank, symbol, price, market_cap, change_1h, change_24h, change_7d, change_30d, volume, scanned_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [period, i + 1, r.symbol, r.price, r.marketCap, r.change1h, r.change24h, r.change7d, r.change30d, r.volume, scannedAt]
            );
          }
        }
        await client.query('COMMIT');
        console.log('[Scanner TopGainers] resultados guardados na BD');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner TopGainers] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    periodGainersState.status = 'error';
    periodGainersState.error  = err.message;
  }
}

function getPeriodGainersState() { return periodGainersState; }

// ─── SCANNER RSI SEMANAL ───────────────────────────────────────
// Pedido pelo utilizador (06/10): todos os perpétuos USDT com RSI(14) semanal
// acima de um limiar (65 por omissão). O RSI "atual" inclui a semana em
// formação (preço de agora — o mesmo valor que o TradingView mostra); o da
// última semana fechada vem ao lado, para ver se o RSI está a subir ou a
// descer. Velas semanais da Bybit (início à 2ª feira 00:00 UTC).
const { RSI } = require('technicalindicators');
const RSI_WEEKLY_PERIOD = 14;
const RSI_WEEKLY_CANDLES = 100; // folga para o RSI de Wilder convergir
const RSI_WEEKLY_CONCURRENCY = 5;
// Um pouco abaixo das 2h do cron — com CACHE_TTL (2h) a contar do FIM do scan
// anterior, o cron seguinte apanhava a cache ainda válida e saltava um ciclo.
const RSI_WEEKLY_CACHE_TTL = 100 * 60 * 1000;

let rsiWeeklyState = { status: 'idle', progress: 0, total: 0, results: [], threshold: 65, scannedAt: null, error: null };

async function ensureRsiWeeklyTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scanner_rsi_weekly (
      id            SERIAL PRIMARY KEY,
      rank          INT            NOT NULL,
      symbol        VARCHAR(50)    NOT NULL,
      price         DECIMAL(20,8)  NOT NULL,
      rsi           DECIMAL(6,2)   NOT NULL,
      rsi_prev_week DECIMAL(6,2),
      change_week   DECIMAL(10,4),
      volume        DECIMAL(24,4),
      scanned_at    TIMESTAMP      NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_rsi_weekly_time ON scanner_rsi_weekly(scanned_at DESC);
  `);
}

async function startScanRsiWeekly(threshold = 65) {
  if (rsiWeeklyState.status === 'scanning') return;
  if (rsiWeeklyState.status === 'done' && rsiWeeklyState.threshold === threshold &&
      rsiWeeklyState.scannedAt && Date.now() - rsiWeeklyState.scannedAt < RSI_WEEKLY_CACHE_TTL) return;

  rsiWeeklyState = { ...rsiWeeklyState, status: 'scanning', progress: 0, total: 0, results: [], threshold, error: null };

  try {
    const markets = await bybit.publicExchange.loadMarkets();
    const perps = Object.values(markets).filter(m =>
      m.linear &&
      m.type === 'swap' &&
      m.settle === 'USDT' &&
      m.active &&
      !m.symbol.includes('USDC')
    );
    rsiWeeklyState.total = perps.length;
    console.log(`[Scanner RSI semanal] ${perps.length} pares elegíveis — limiar ${threshold}`);

    // Volume 24h (USDT) num só pedido — só para mostrar na tabela
    let turnover = {};
    try {
      const tickers = await bybit.publicExchange.fetchTickers(undefined, { category: 'linear' });
      turnover = Object.fromEntries(Object.values(tickers).map(t => [t.symbol, parseFloat(t.info?.turnover24h || 0)]));
    } catch { /* sem volume — o RSI continua a ser calculado */ }

    const results = [];
    let next = 0;
    async function worker() {
      while (next < perps.length) {
        const market = perps[next++];
        try {
          const weekly = await bybit.getCandles(market.symbol, '1w', RSI_WEEKLY_CANDLES);
          if (weekly.length < RSI_WEEKLY_PERIOD + 2) continue; // listagem recente, sem semanas suficientes
          const closes = weekly.map(c => c.close);
          const rsiArr = RSI.calculate({ period: RSI_WEEKLY_PERIOD, values: closes });
          const rsi = rsiArr[rsiArr.length - 1];
          if (rsi == null || rsi <= threshold) continue;
          const current = weekly[weekly.length - 1]; // semana em formação
          results.push({
            symbol:      market.symbol,
            price:       current.close,
            rsi,
            rsiPrevWeek: rsiArr[rsiArr.length - 2] ?? null,
            changeWeek:  current.open > 0 ? ((current.close - current.open) / current.open) * 100 : null,
            volume:      turnover[market.symbol] ?? 0,
          });
        } catch {
          // par sem dados, ignora
        } finally {
          rsiWeeklyState.progress++;
        }
      }
    }
    await Promise.all(Array.from({ length: RSI_WEEKLY_CONCURRENCY }, worker));

    results.sort((a, b) => b.rsi - a.rsi);
    const scannedAt = new Date();
    rsiWeeklyState.results   = results;
    rsiWeeklyState.scannedAt = scannedAt.getTime();
    rsiWeeklyState.status    = 'done';
    console.log(`[Scanner RSI semanal] ${results.length} pares com RSI semanal > ${threshold}`);

    // Guarda no histórico da BD (silencioso se BD não estiver configurada)
    try {
      await ensureRsiWeeklyTable();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          await client.query(
            `INSERT INTO scanner_rsi_weekly (rank, symbol, price, rsi, rsi_prev_week, change_week, volume, scanned_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [i + 1, r.symbol, r.price, r.rsi, r.rsiPrevWeek, r.changeWeek, r.volume, scannedAt]
          );
        }
        await client.query('COMMIT');
        console.log(`[Scanner RSI semanal] ${results.length} resultados guardados na BD`);
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.warn('[Scanner RSI semanal] Erro ao guardar no BD:', dbErr.message);
      } finally {
        client.release();
      }
    } catch {
      // BD não configurada — continua sem guardar
    }
  } catch (err) {
    rsiWeeklyState.status = 'error';
    rsiWeeklyState.error  = err.message;
  }
}

function getRsiWeeklyState() { return rsiWeeklyState; }

// ─── SCANNER RUMER'S BOX (dia / semana / mês) ──────────────────
// Pedido pelo utilizador (09/10) a partir do detector de outra app (ver
// rumersBox.js): LONG quando a vela 15m fecha acima do máximo do dia / semana
// / mês anterior, vinda de dentro da caixa. Corre 1min depois de cada fecho de
// vela 15m sobre todos os perpétuos USDT. Regista TODAS as quebras (como o
// original), numeradas dentro de cada caixa (breakNo) — no universo inteiro
// o preço volta a cruzar o máximo muitas vezes (estudo 7d: ~600 quebras/dia
// na caixa diária, ~250 se só contar a 1ª), por isso a UI mostra por omissão
// só a 1ª quebra de cada caixa.
const rumersBox = require('./rumersBox');
const RUMERS_CONCURRENCY = 6;
const RUMERS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;   // sinais mantidos em memória
const RUMERS_COUNT_KEEP_MS = 35 * 24 * 60 * 60 * 1000; // contadores de quebras (cobre a caixa mensal)
// Alertas Telegram (pedido do utilizador 09/10): só a 1ª quebra de cada caixa
// semanal/mensal (~60/dia no estudo de 7d) — a diária dá ~250/dia, demasiado
// ruído. Uma mensagem por vela 15m com todas as quebras dessa vela.
const RUMERS_TELEGRAM_TYPES = new Set(
  (process.env.RUMERS_TELEGRAM_TYPES || 'week,month').split(',').map(s => s.trim()).filter(Boolean)
);
const RUMERS_TELEGRAM_MAX_LINES = 25; // limite de 4096 caracteres por mensagem do Telegram
const RUMERS_TYPE_LABEL = { day: 'Diário', week: 'Semanal', month: 'Mensal' };

function sendRumersTelegram(hits, barTime) {
  const alerts = hits.filter(h => h.breakNo === 1 && RUMERS_TELEGRAM_TYPES.has(h.type));
  if (!alerts.length) return;
  const fmtPx = (x) => Number(x.toPrecision(6));
  const lines = [];
  for (const type of ['month', 'week', 'day']) {
    const group = alerts.filter(h => h.type === type).sort((a, b) => b.strength - a.strength);
    if (!group.length) continue;
    lines.push(`\n<b>${RUMERS_TYPE_LABEL[type]}</b> (caixa ${group[0].periodKey})`);
    for (const h of group) {
      lines.push(
        `<b>${h.symbol.split('/')[0]}</b> ${fmtPx(h.entryPrice)} · quebra +${h.breakPct.toFixed(2)}% · caixa ${h.boxRangePct.toFixed(1)}% · ` +
        `força ${h.strength} · SL ${fmtPx(h.stopLoss)} · TP1 ${fmtPx(h.target1)}`
      );
    }
  }
  const shown = lines.slice(0, RUMERS_TELEGRAM_MAX_LINES);
  const extra = lines.length - shown.length;
  const closeTime = new Date(barTime + 15 * 60 * 1000).toISOString().slice(11, 16);
  const msg = `📦 <b>Rumer's Box</b> · LONG · vela 15m fechada às ${closeTime} UTC\n${shown.join('\n')}` +
    (extra > 0 ? `\n\n… e mais ${extra} (ver app)` : '');
  telegram.sendMessage(msg); // não bloqueia o scan — falha de envio é só um warning na consola
}

let rumersState = {
  status: 'idle', progress: 0, total: 0, lastBarTime: null, scannedAt: null, error: null,
  hits: [], // mais recentes primeiro
};
// Velas diárias por símbolo, refrescadas uma vez por dia UTC — dão as três caixas
const rumersDailyCache = { dayStart: null, bySymbol: new Map() };
// 'type|symbol|periodKey' → nº de quebras já registadas nessa caixa
const rumersBreakCounts = new Map();
let rumersLoaded = false;

async function ensureRumersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scanner_rumers_box (
      id            SERIAL PRIMARY KEY,
      box_type      VARCHAR(5)     NOT NULL,
      symbol        VARCHAR(50)    NOT NULL,
      period_key    VARCHAR(10)    NOT NULL,
      break_no      INT            NOT NULL,
      entry_price   DECIMAL(20,8)  NOT NULL,
      stop_loss     DECIMAL(20,8)  NOT NULL,
      target1       DECIMAL(20,8)  NOT NULL,
      strength      INT            NOT NULL,
      break_pct     DECIMAL(10,4)  NOT NULL,
      prev_high     DECIMAL(20,8)  NOT NULL,
      prev_low      DECIMAL(20,8)  NOT NULL,
      box_range_pct DECIMAL(10,4)  NOT NULL,
      bar_time      TIMESTAMP      NOT NULL,
      detected_at   TIMESTAMP      NOT NULL DEFAULT NOW(),
      UNIQUE (box_type, symbol, bar_time)
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_rumers_box_time ON scanner_rumers_box(bar_time DESC);
  `);
}

function rumersRowToHit(r) {
  return {
    type: r.box_type, symbol: r.symbol, periodKey: r.period_key, breakNo: r.break_no,
    entryPrice: parseFloat(r.entry_price), stopLoss: parseFloat(r.stop_loss), target1: parseFloat(r.target1),
    strength: r.strength, breakPct: parseFloat(r.break_pct),
    prevHigh: parseFloat(r.prev_high), prevLow: parseFloat(r.prev_low), boxRangePct: parseFloat(r.box_range_pct),
    barTime: new Date(r.bar_time).getTime(),
  };
}

// Ao arrancar: recupera da BD os sinais recentes e os contadores de quebras,
// para o breakNo continuar certo depois de um restart/deploy.
async function loadRumersFromDb() {
  if (rumersLoaded) return;
  rumersLoaded = true;
  try {
    await ensureRumersTable();
    const { rows } = await pool.query(
      `SELECT * FROM scanner_rumers_box WHERE bar_time > NOW() - INTERVAL '35 days' ORDER BY bar_time DESC`
    );
    for (const r of rows) {
      const key = `${r.box_type}|${r.symbol}|${r.period_key}`;
      rumersBreakCounts.set(key, Math.max(rumersBreakCounts.get(key) || 0, r.break_no));
    }
    const since = Date.now() - RUMERS_KEEP_MS;
    rumersState.hits = rows.map(rumersRowToHit).filter(h => h.barTime >= since);
    if (rows.length) console.log(`[Scanner Rumer's Box] ${rumersState.hits.length} sinais recentes carregados da BD`);
  } catch { /* BD não configurada — começa vazio */ }
}

// Símbolos sem velas diárias do dia UTC atual (a cache limpa-se à meia-noite UTC)
function rumersSymbolsNeedingDaily(symbols, now) {
  const dayStart = Math.floor(now / 864e5) * 864e5;
  if (rumersDailyCache.dayStart !== dayStart) {
    rumersDailyCache.dayStart = dayStart;
    rumersDailyCache.bySymbol.clear();
  }
  return symbols.filter(s => !rumersDailyCache.bySymbol.has(s));
}

async function startScanRumersBox() {
  if (rumersState.status === 'scanning') return;
  await loadRumersFromDb();

  const now = Date.now();
  const barTime = Math.floor(now / 900e3) * 900e3 - 900e3; // abertura da última vela 15m fechada
  if (rumersState.lastBarTime === barTime) return; // esta vela já foi analisada

  rumersState = { ...rumersState, status: 'scanning', progress: 0, total: 0, error: null };

  try {
    const markets = await bybit.publicExchange.loadMarkets();
    const symbols = Object.values(markets).filter(m =>
      m.linear &&
      m.type === 'swap' &&
      m.settle === 'USDT' &&
      m.active &&
      !m.symbol.includes('USDC')
    ).map(m => m.symbol);

    const needDaily = rumersSymbolsNeedingDaily(symbols, now);
    rumersState.total = symbols.length + needDaily.length;
    console.log(`[Scanner Rumer's Box] ${symbols.length} pares · ${needDaily.length} com velas diárias a atualizar`);

    async function runPool(items, fn) {
      let next = 0;
      async function worker() {
        while (next < items.length) {
          const item = items[next++];
          try { await fn(item); } catch { /* par sem dados, ignora */ } finally { rumersState.progress++; }
        }
      }
      await Promise.all(Array.from({ length: RUMERS_CONCURRENCY }, worker));
    }

    await runPool(needDaily, async (symbol) => {
      // 80 velas diárias cobrem o mês anterior inteiro mesmo no fim de um mês de 31 dias
      const daily = await bybit.getCandles(symbol, '1d', 80);
      rumersDailyCache.bySymbol.set(symbol, daily.map(c => ({ time: +c.time, high: c.high, low: c.low })));
    });

    const newHits = [];
    await runPool(symbols, async (symbol) => {
      const daily = rumersDailyCache.bySymbol.get(symbol);
      if (!daily) return;
      const c15 = (await bybit.getCandles(symbol, '15m', 4)).map(c => ({ time: +c.time, close: c.close }));
      const closed = c15.filter(c => c.time <= barTime);
      if (!closed.length || closed[closed.length - 1].time !== barTime) return; // sem a vela que acabou de fechar

      for (const type of rumersBox.BOX_TYPES) {
        const levels = rumersBox.computeBoxLevels(daily, type, now);
        if (!levels) continue;
        const hit = rumersBox.detectBreakout(closed, levels, rumersBox.RUMERS_BOX_DEFAULTS, now);
        if (!hit) continue;
        const key = `${type}|${symbol}|${levels.periodKey}`;
        const breakNo = (rumersBreakCounts.get(key) || 0) + 1;
        rumersBreakCounts.set(key, breakNo);
        newHits.push({
          type, symbol, periodKey: levels.periodKey, breakNo,
          entryPrice: hit.entryPrice, stopLoss: hit.stopLoss, target1: hit.target1,
          strength: hit.strength, breakPct: hit.breakPct,
          prevHigh: levels.prevHigh, prevLow: levels.prevLow, boxRangePct: levels.boxRangePct,
          barTime: hit.barTime,
        });
      }
    });

    newHits.sort((a, b) => b.strength - a.strength);
    const keepSince = Date.now() - RUMERS_KEEP_MS;
    rumersState.hits = [...newHits, ...rumersState.hits].filter(h => h.barTime >= keepSince);
    rumersState.lastBarTime = barTime;
    rumersState.scannedAt = Date.now();
    rumersState.status = 'done';
    // contadores de caixas que já não podem voltar a ser quebradas
    const countSince = Date.now() - RUMERS_COUNT_KEEP_MS;
    for (const key of rumersBreakCounts.keys()) {
      const periodKey = key.split('|')[2];
      if (Date.parse(periodKey.length === 7 ? `${periodKey}-01` : periodKey) < countSince) rumersBreakCounts.delete(key);
    }
    const byType = Object.fromEntries(rumersBox.BOX_TYPES.map(t => [t, newHits.filter(h => h.type === t).length]));
    console.log(`[Scanner Rumer's Box] vela ${new Date(barTime).toISOString().slice(11, 16)} UTC — quebras: dia ${byType.day} · semana ${byType.week} · mês ${byType.month}`);
    sendRumersTelegram(newHits, barTime);

    if (newHits.length) {
      try {
        await ensureRumersTable();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const h of newHits) {
            await client.query(
              `INSERT INTO scanner_rumers_box (box_type, symbol, period_key, break_no, entry_price, stop_loss, target1, strength, break_pct, prev_high, prev_low, box_range_pct, bar_time)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               ON CONFLICT (box_type, symbol, bar_time) DO NOTHING`,
              [h.type, h.symbol, h.periodKey, h.breakNo, h.entryPrice, h.stopLoss, h.target1, h.strength,
               h.breakPct, h.prevHigh, h.prevLow, h.boxRangePct, new Date(h.barTime)]
            );
          }
          await client.query('COMMIT');
        } catch (dbErr) {
          await client.query('ROLLBACK');
          console.warn("[Scanner Rumer's Box] Erro ao guardar no BD:", dbErr.message);
        } finally {
          client.release();
        }
      } catch {
        // BD não configurada — continua sem guardar
      }
    }
  } catch (err) {
    rumersState.status = 'error';
    rumersState.error = err.message;
  }
}

/** Estado + sinais filtrados: type = day|week|month, hours, firstOnly. */
function getRumersBoxState({ type = null, hours = 24, firstOnly = true } = {}) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const hits = rumersState.hits
    .filter(h => (!type || h.type === type) && h.barTime >= since && (!firstOnly || h.breakNo === 1))
    .sort((a, b) => b.barTime - a.barTime || b.strength - a.strength);
  const { hits: _all, ...rest } = rumersState;
  return { ...rest, params: rumersBox.RUMERS_BOX_DEFAULTS, hits };
}

module.exports = {
  startScan, getState,
  startScanGainers, getGainersState,
  startScanPump, getPumpState,
  startScanEmaTrend, getEmaTrendState,
  startScanEmaTrendStocks, getEmaTrendStocksState,
  startScanEmaTrendTotal, getEmaTrendTotalState,
  startScanVolatile50, getVolatile50State,
  startScanVolatile50_4h, getVolatile50State4h,
  startScanPeriodGainers, getPeriodGainersState,
  startScanRsiWeekly, getRsiWeeklyState,
  startScanRumersBox, getRumersBoxState, loadRumersFromDb,
};
