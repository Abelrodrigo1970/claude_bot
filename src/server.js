require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const pool = require('./db/pool');
const { runAll, runStrategy, STRATEGIES, getRunState, resolveSymbols, getMemorySignals, setStrategyEnabled } = require('./services/runner');
const {
  startScan, getState,
  startScanGainers, getGainersState,
  startScanPump, getPumpState,
  startScanEmaTrend, getEmaTrendState,
  startScanEmaTrendStocks, getEmaTrendStocksState,
  startScanVolatile50, getVolatile50State,
  startScanVolatile50_4h, getVolatile50State4h,
} = require('./services/scanner');

const app = express();
app.use(cors());
app.use(express.json());

// ─── API ROUTES ────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Lista todas as estratégias
app.get('/api/strategies', (req, res) => {
  res.json(STRATEGIES.map(s => ({
    name:          s.name,
    market:        s.market || 'crypto',
    symbol:        s.symbol,
    symbols:       s.symbols || null,
    scannerPeriod: s.scannerPeriod || null,
    symbolSource:  s.symbolSource || null,
    symbolCount:   s.symbols?.length ?? ((s.symbolSource || s.scannerPeriod) ? resolveSymbols(s).length : 1),
    timeframe:     s.timeframe,
    enabled:       s.enabled,
  })));
});

// Liga/desliga uma estratégia (persistido — sobrevive a reinicios/deploys)
app.post('/api/strategies/:name/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled deve ser boolean' });
    const strategy = await setStrategyEnabled(req.params.name, enabled);
    res.json({ name: strategy.name, enabled: strategy.enabled });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Estado da execução em curso (para progresso na UI)
app.get('/api/run/state', (req, res) => res.json(getRunState()));

// Histórico de trades
app.get('/api/trades', async (req, res) => {
  try {
    const { strategy, status, limit = 50 } = req.query;
    let query = 'SELECT * FROM trades WHERE 1=1';
    const params = [];

    if (strategy) { params.push(strategy); query += ` AND strategy_name=$${params.length}`; }
    if (status) { params.push(status); query += ` AND status=$${params.length}`; }

    params.push(parseInt(limit));
    query += ` ORDER BY opened_at DESC LIMIT $${params.length}`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sinais recentes (BD com fallback em memória)
app.get('/api/signals', async (req, res) => {
  const { limit = 100, strategy } = req.query;
  try {
    let query = 'SELECT * FROM signals WHERE 1=1';
    const params = [];
    if (strategy) { params.push(strategy); query += ` AND strategy_name=$${params.length}`; }
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch {
    // BD não disponível — devolve sinais em memória
    let signals = getMemorySignals();
    if (strategy) signals = signals.filter(s => s.strategy_name === strategy);
    res.json(signals.slice(0, parseInt(limit)));
  }
});

// Estatísticas por estratégia
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        ss.*,
        COALESCE(SUM(t.pnl), 0) as total_pnl_calc,
        COUNT(t.id) FILTER (WHERE t.status = 'open') as open_trades
      FROM strategy_stats ss
      LEFT JOIN trades t ON t.strategy_name = ss.strategy_name AND t.symbol = ss.symbol
      GROUP BY ss.id
      ORDER BY ss.updated_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PnL por dia (para gráfico)
app.get('/api/pnl/daily', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        DATE(closed_at) as date,
        strategy_name,
        SUM(pnl) as daily_pnl,
        COUNT(*) as trades
      FROM trades
      WHERE status = 'closed' AND closed_at IS NOT NULL
      GROUP BY DATE(closed_at), strategy_name
      ORDER BY date ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forçar execução manual
app.post('/api/run', async (req, res) => {
  try {
    await runAll();
    res.json({ success: true, message: 'Estratégias executadas' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STOCKS ────────────────────────────────────────────────────

app.get('/api/stocks', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, symbol, ticker, category, active FROM stock_symbols WHERE active=true ORDER BY category, ticker`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stocks/monthly', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT symbol, ticker FROM stock_symbols WHERE active=true`);
    const { getCandles } = require('./services/bybit');
    const result = {};
    const chunks = [];
    for (let i = 0; i < rows.length; i += 5) chunks.push(rows.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async ({ symbol, ticker }) => {
        try {
          const candles = await getCandles(symbol, '1d', 31);
          if (candles.length >= 2) {
            const current  = candles[candles.length - 1].close;
            const monthAgo = candles[0].close;
            result[ticker] = ((current - monthAgo) / monthAgo) * 100;
          }
        } catch { result[ticker] = null; }
      }));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stocks/prices', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT symbol, ticker FROM stock_symbols WHERE active=true`);
    const symbols = rows.map(r => r.symbol);
    const { exchange } = require('./services/bybit');
    const tickers = await exchange.fetchTickers(symbols);
    const result = {};
    for (const [sym, data] of Object.entries(tickers)) {
      const ticker = sym.split('/')[0];
      result[ticker] = {
        price:     data.last,
        change24h: data.percentage,
        volume24h: data.quoteVolume,
        high24h:   data.high,
        low24h:    data.low,
      };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SCANNER ───────────────────────────────────────────────────

// Inicia scan (fire-and-forget) — ?period=200 ou ?period=90
app.post('/api/scanner/start', (req, res) => {
  const period = parseInt(req.query.period) || 200;
  startScan(period, 50);
  res.json({ ok: true });
});

// GET para cron jobs externos — corre scanner EMA90 + estratégias
app.get('/api/cron/run', async (req, res) => {
  res.json({ ok: true, message: 'Ciclo iniciado', time: new Date() });
  await startScan(90, 50);
  await runAll();
});

// GET para cron jobs externos — só scanner EMA200
app.get('/api/cron/scan200', (req, res) => {
  res.json({ ok: true, message: 'Scanner EMA200 iniciado', time: new Date() });
  startScan(200, 50);
});

// Estado atual do scan (polling)
app.get('/api/scanner', (req, res) => {
  const period = parseInt(req.query.period) || 200;
  res.json(getState(period));
});

// Histórico de scans anteriores — ?period=200&sessions=10
app.get('/api/scanner/history', async (req, res) => {
  try {
    const period   = parseInt(req.query.period)   || 200;
    const sessions = parseInt(req.query.sessions) || 10;

    // Últimas N sessões distintas
    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_results
       WHERE ema_period = $1
       ORDER BY scanned_at DESC LIMIT $2`,
      [period, sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_results
       WHERE ema_period = $1 AND scanned_at = ANY($2)
       ORDER BY scanned_at DESC, rank ASC`,
      [period, dates]
    );

    // Agrupa por sessão
    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia scan de topo de ganhos 24h (fire-and-forget) — ?limit=4
app.post('/api/scanner/gainers/start', (req, res) => {
  const limit = parseInt(req.query.limit) || 4;
  startScanGainers(limit);
  res.json({ ok: true });
});

// GET para cron jobs externos — scanner Top ganhos 24h
app.get('/api/cron/scanGainers', (req, res) => {
  res.json({ ok: true, message: 'Scanner Top 24h iniciado', time: new Date() });
  startScanGainers(4);
});

// Estado atual do scan de ganhos 24h (polling)
app.get('/api/scanner/gainers', (req, res) => {
  res.json(getGainersState());
});

// Histórico de scans de ganhos 24h — ?sessions=10
app.get('/api/scanner/gainers/history', async (req, res) => {
  try {
    const sessions = parseInt(req.query.sessions) || 10;

    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_gainers ORDER BY scanned_at DESC LIMIT $1`,
      [sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_gainers WHERE scanned_at = ANY($1) ORDER BY scanned_at DESC, rank ASC`,
      [dates]
    );

    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia scan de pump 24h — todos os pares acima do limiar, sem top-N — ?threshold=10
app.post('/api/scanner/pump/start', (req, res) => {
  const threshold = parseFloat(req.query.threshold) || 10;
  startScanPump(threshold);
  res.json({ ok: true });
});

// GET para cron jobs externos — scanner Pump 24h
app.get('/api/cron/scanPump', (req, res) => {
  res.json({ ok: true, message: 'Scanner Pump 24h iniciado', time: new Date() });
  startScanPump(10);
});

// Estado atual do scan de pump 24h (polling)
app.get('/api/scanner/pump', (req, res) => {
  res.json(getPumpState());
});

// Histórico de scans de pump 24h — ?sessions=10
app.get('/api/scanner/pump/history', async (req, res) => {
  try {
    const sessions = parseInt(req.query.sessions) || 10;

    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_pump ORDER BY scanned_at DESC LIMIT $1`,
      [sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_pump WHERE scanned_at = ANY($1) ORDER BY scanned_at DESC, rank ASC`,
      [dates]
    );

    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia scan EMA Trend (21/50, diário+1h) — ?limit=50
app.post('/api/scanner/ematrend/start', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  startScanEmaTrend(limit);
  res.json({ ok: true });
});

// GET para cron jobs externos — scanner EMA Trend
app.get('/api/cron/scanEmaTrend', (req, res) => {
  res.json({ ok: true, message: 'Scanner EMA Trend iniciado', time: new Date() });
  startScanEmaTrend(50);
});

// Estado atual do scan EMA Trend (polling)
app.get('/api/scanner/ematrend', (req, res) => {
  res.json(getEmaTrendState());
});

// Histórico de scans EMA Trend — ?sessions=10
app.get('/api/scanner/ematrend/history', async (req, res) => {
  try {
    const sessions = parseInt(req.query.sessions) || 10;

    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_ema_trend ORDER BY scanned_at DESC LIMIT $1`,
      [sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_ema_trend WHERE scanned_at = ANY($1) ORDER BY scanned_at DESC, rank ASC`,
      [dates]
    );

    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia scan EMA Trend Stocks (21/50, diário+1h, universo stock_symbols) — ?limit=50
app.post('/api/scanner/ematrend-stocks/start', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  startScanEmaTrendStocks(limit);
  res.json({ ok: true });
});

// GET para cron jobs externos — scanner EMA Trend Stocks
app.get('/api/cron/scanEmaTrendStocks', (req, res) => {
  res.json({ ok: true, message: 'Scanner EMA Trend Stocks iniciado', time: new Date() });
  startScanEmaTrendStocks(50);
});

// Estado atual do scan EMA Trend Stocks (polling)
app.get('/api/scanner/ematrend-stocks', (req, res) => {
  res.json(getEmaTrendStocksState());
});

// Histórico de scans EMA Trend Stocks — ?sessions=10
app.get('/api/scanner/ematrend-stocks/history', async (req, res) => {
  try {
    const sessions = parseInt(req.query.sessions) || 10;

    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_ema_trend_stocks ORDER BY scanned_at DESC LIMIT $1`,
      [sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_ema_trend_stocks WHERE scanned_at = ANY($1) ORDER BY scanned_at DESC, rank ASC`,
      [dates]
    );

    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia scan da Lista 50 (spike de volume 5x + subida, velas de 15m)
app.post('/api/scanner/volatile50/start', (req, res) => {
  startScanVolatile50();
  res.json({ ok: true });
});

// GET para cron jobs externos — scanner Lista 50
app.get('/api/cron/scanVolatile50', (req, res) => {
  res.json({ ok: true, message: 'Scanner Lista 50 iniciado', time: new Date() });
  startScanVolatile50();
});

// Estado atual do scan da Lista 50 (polling)
app.get('/api/scanner/volatile50', (req, res) => {
  res.json(getVolatile50State());
});

// Histórico de scans da Lista 50 — ?sessions=10
app.get('/api/scanner/volatile50/history', async (req, res) => {
  try {
    const sessions = parseInt(req.query.sessions) || 10;

    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_volatile50 ORDER BY scanned_at DESC LIMIT $1`,
      [sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_volatile50 WHERE scanned_at = ANY($1) ORDER BY scanned_at DESC, rank ASC`,
      [dates]
    );

    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mesma Lista 50, mas em velas de 4h (ver createVolatile50Scanner em
// services/scanner.js) — rotas espelham as da versão 15m acima.
app.post('/api/scanner/volatile50-4h/start', (req, res) => {
  startScanVolatile50_4h();
  res.json({ ok: true });
});

app.get('/api/cron/scanVolatile50_4h', (req, res) => {
  res.json({ ok: true, message: 'Scanner Lista 50 (4h) iniciado', time: new Date() });
  startScanVolatile50_4h();
});

app.get('/api/scanner/volatile50-4h', (req, res) => {
  res.json(getVolatile50State4h());
});

app.get('/api/scanner/volatile50-4h/history', async (req, res) => {
  try {
    const sessions = parseInt(req.query.sessions) || 10;

    const { rows: sessionRows } = await pool.query(
      `SELECT DISTINCT scanned_at FROM scanner_volatile50_4h ORDER BY scanned_at DESC LIMIT $1`,
      [sessions]
    );

    if (!sessionRows.length) return res.json([]);

    const dates = sessionRows.map(r => r.scanned_at);
    const { rows } = await pool.query(
      `SELECT * FROM scanner_volatile50_4h WHERE scanned_at = ANY($1) ORDER BY scanned_at DESC, rank ASC`,
      [dates]
    );

    const grouped = {};
    rows.forEach(r => {
      const key = r.scanned_at.toISOString();
      if (!grouped[key]) grouped[key] = { scanned_at: r.scanned_at, results: [] };
      grouped[key].results.push(r);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATIC FILES (React build) ────────────────────────────────

const buildPath = path.join(__dirname, '../build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// ─── CRON JOBS ─────────────────────────────────────────────────

// A cada hora: scanner EMA90 (usa cache 2h) → estratégias
cron.schedule('5 * * * *', async () => {
  console.log('\n⏰ Cron 1h: a correr scanner EMA90...');
  await startScan(90, 50);
  console.log('⏰ Cron 1h: scanner concluído — a executar estratégias...');
  await runAll();
  console.log('⏰ Cron 1h: ciclo completo.');
});

// Diário às 00:05 UTC: scanner EMA200 (velas diárias frescas)
cron.schedule('5 0 * * *', async () => {
  console.log('\n📅 Cron diário: a correr scanner EMA200...');
  await startScan(200, 50);
  console.log('📅 Cron diário: EMA200 concluído.');
});

// A cada hora: scanner EMA Trend (21/50, diário+1h) — usa cache 2h
cron.schedule('10 * * * *', async () => {
  console.log('\n📐 Cron 1h: a correr scanner EMA Trend...');
  await startScanEmaTrend(50);
  console.log('📐 Cron 1h: scanner EMA Trend concluído.');
});

// A cada hora: scanner EMA Trend Stocks (21/50, diário+1h, universo stocks/ETFs) — usa cache 2h
cron.schedule('20 * * * *', async () => {
  console.log('\n📐 Cron 1h: a correr scanner EMA Trend Stocks...');
  await startScanEmaTrendStocks(50);
  console.log('📐 Cron 1h: scanner EMA Trend Stocks concluído.');
});

// A cada 2 horas: scanner Top 4 ganhos 24h
cron.schedule('15 */2 * * *', async () => {
  console.log('\n📈 Cron 2h: a correr scanner Top 4 (24h)...');
  await startScanGainers(4);
  console.log('📈 Cron 2h: scanner Top 4 (24h) concluído.');
});

// A cada 2 horas: scanner Pump 24h (todos os pares acima de +10%, sem top-N)
cron.schedule('25 */2 * * *', async () => {
  console.log('\n🚀 Cron 2h: a correr scanner Pump 24h...');
  await startScanPump(10);
  console.log('🚀 Cron 2h: scanner Pump 24h concluído.');
});

// A cada 15 min (2min depois de cada fecho de vela): scanner Lista 50 —
// deteta spike de volume (>=5x a média das 10 velas anteriores) + subida
// nos 50 símbolos de src/backtests/data/top50-6month-movers.json.
cron.schedule('2,17,32,47 * * * *', async () => {
  console.log('\n⚡ Cron 15m: a correr scanner Lista 50 (spike de volume)...');
  await startScanVolatile50();
  console.log('⚡ Cron 15m: scanner Lista 50 concluído.');
});

// A cada hora: scanner Lista 50 em 4h (mesma lógica, velas de 4h — a cache
// de 55min evita recalcular sem uma vela nova ter fechado entretanto).
cron.schedule('50 * * * *', async () => {
  console.log('\n⚡ Cron 1h: a correr scanner Lista 50 4h (spike de volume)...');
  await startScanVolatile50_4h();
  console.log('⚡ Cron 1h: scanner Lista 50 4h concluído.');
});

// A cada 15 min: estratégias de 15m (ex: PumpEma60Band sobre o Pump 24h) —
// runStrategy() já chama ensureSymbols() internamente, por isso não precisa
// de esperar pelo pré-passo do cron horário para ter símbolos.
cron.schedule('*/15 * * * *', async () => {
  const fastStrategies = STRATEGIES.filter(s => s.timeframe === '15m');
  if (!fastStrategies.length) return;
  console.log('\n⏱️  Cron 15m: a correr estratégias rápidas...');
  for (const s of fastStrategies) await runStrategy(s);
  console.log('⏱️  Cron 15m: concluído.');
});

// ─── START ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Cripto Bot Server rodando na porta ${PORT}`);
  console.log(`📊 Estratégias com trading real na Bybit: ${STRATEGIES.filter(s => s.enabled).length}/${STRATEGIES.length}`);
  console.log(`⏰ Ciclo automático: scanner EMA90 + estratégias a cada hora\n`);

  // Executa ao arrancar
  setTimeout(runAll, 3000);
});
