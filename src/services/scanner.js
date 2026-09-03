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
// 4h: cache mais longa (55min) porque a vela só muda a cada 4h — corre a
// cada hora via cron, não vale a pena recalcular mais vezes que isso.
const volatile50Scanner4h = createVolatile50Scanner({
  timeframe: '4h', tableName: 'scanner_volatile50_4h', cacheTtl: 55 * 60 * 1000, label: 'Lista50 4h',
});

async function startScanVolatile50() { return volatile50Scanner15m.startScan(); }
function getVolatile50State() { return volatile50Scanner15m.getState(); }
async function startScanVolatile50_4h() { return volatile50Scanner4h.startScan(); }
function getVolatile50State4h() { return volatile50Scanner4h.getState(); }

module.exports = {
  startScan, getState,
  startScanGainers, getGainersState,
  startScanPump, getPumpState,
  startScanEmaTrend, getEmaTrendState,
  startScanEmaTrendStocks, getEmaTrendStocksState,
  startScanEmaTrendTotal, getEmaTrendTotalState,
  startScanVolatile50, getVolatile50State,
  startScanVolatile50_4h, getVolatile50State4h,
};
