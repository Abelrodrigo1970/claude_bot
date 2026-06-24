require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const pool = require('./db/pool');
const { runAll, STRATEGIES, getRunState, resolveSymbols, getMemorySignals } = require('./services/runner');
const { startScan, getState } = require('./services/scanner');

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
    symbol:        s.symbol,
    scannerPeriod: s.scannerPeriod || null,
    symbolCount:   s.scannerPeriod ? resolveSymbols(s).length : 1,
    timeframe:     s.timeframe,
    enabled:       s.enabled,
  })));
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

// ─── SCANNER ───────────────────────────────────────────────────

// Inicia scan (fire-and-forget) — ?period=200 ou ?period=90
app.post('/api/scanner/start', (req, res) => {
  const period = parseInt(req.query.period) || 200;
  startScan(period, 50);
  res.json({ ok: true });
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

// ─── STATIC FILES (React build) ────────────────────────────────

const buildPath = path.join(__dirname, '../build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// ─── CRON JOBS ─────────────────────────────────────────────────

// Corre a cada hora no fecho da vela (ex: 1h timeframe -> corre às :01)
cron.schedule('1 * * * *', async () => {
  console.log('\n⏰ Cron: executando estratégias...');
  await runAll();
});

// ─── START ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Cripto Bot Server rodando na porta ${PORT}`);
  console.log(`📊 Estratégias ativas: ${STRATEGIES.filter(s => s.enabled).length}`);
  console.log(`⏰ Próxima execução automática: a cada hora\n`);

  // Executa ao arrancar
  setTimeout(runAll, 3000);
});
