const { EMA } = require('technicalindicators');
const bybit = require('./bybit');
const pool  = require('../db/pool');

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 horas — alinhado com o ciclo do cron

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

let gainersState = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

async function startScanGainers(limit = 6) {
  if (gainersState.status === 'scanning') return;
  if (gainersState.status === 'done' && gainersState.scannedAt && Date.now() - gainersState.scannedAt < CACHE_TTL) return;

  gainersState = { ...gainersState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.exchange.loadMarkets();

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
    const tickers = await bybit.exchange.fetchTickers(symbols);
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

    gainersState.results   = top;
    gainersState.scannedAt = scannedAt.getTime();
    gainersState.status    = 'done';

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

// ─── SCANNER EMA TREND (21/50, diário + 1h) ────────────────────
// Só entram os pares em que o preço está acima da EMA21 E da EMA50,
// tanto no diário como no 1h — 4 condições simultâneas.

let emaTrendState = { status: 'idle', progress: 0, total: 0, results: [], scannedAt: null, error: null };

async function startScanEmaTrend(limit = 50) {
  if (emaTrendState.status === 'scanning') return;
  if (emaTrendState.status === 'done' && emaTrendState.scannedAt && Date.now() - emaTrendState.scannedAt < CACHE_TTL) return;

  emaTrendState = { ...emaTrendState, status: 'scanning', progress: 0, total: 0, results: [], error: null };

  try {
    const markets = await bybit.exchange.loadMarkets();

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
      const tickers = await bybit.exchange.fetchTickers(perps.map(m => m.symbol));
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

module.exports = {
  startScan, getState,
  startScanGainers, getGainersState,
  startScanEmaTrend, getEmaTrendState,
};
