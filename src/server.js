require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const pool = require('./db/pool');
const { runAll, STRATEGIES } = require('./services/runner');

const app = express();
app.use(cors());
app.use(express.json());

// ─── API ROUTES ────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Lista todas as estratégias
app.get('/api/strategies', (req, res) => {
  res.json(STRATEGIES.map(s => ({
    name: s.name,
    symbol: s.symbol,
    timeframe: s.timeframe,
    enabled: s.enabled,
  })));
});

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

// Sinais recentes
app.get('/api/signals', async (req, res) => {
  try {
    const { limit = 50, strategy } = req.query;
    let query = 'SELECT * FROM signals WHERE 1=1';
    const params = [];

    if (strategy) { params.push(strategy); query += ` AND strategy_name=$${params.length}`; }
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
