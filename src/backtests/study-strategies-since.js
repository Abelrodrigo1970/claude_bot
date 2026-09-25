// Estudo de performance de todas as estratégias a partir de uma data, com base
// na tabela `trades` (execução real/paper em runner.js).
// Corre com: node src/backtests/study-strategies-since.js [YYYY-MM-DD]
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const since = process.argv[2] || '2026-08-01';
  const client = await pool.connect();
  try {
    const totalRes = await client.query(
      `SELECT COUNT(*) AS n, MIN(opened_at) AS first, MAX(opened_at) AS last
       FROM trades WHERE opened_at >= $1`, [since]
    );
    console.log('Total trades desde', since, ':', totalRes.rows[0]);

    const byStrategy = await client.query(`
      SELECT
        strategy_name,
        COUNT(*) AS total_trades,
        COUNT(*) FILTER (WHERE status = 'closed') AS closed_trades,
        COUNT(*) FILTER (WHERE status = 'open') AS open_trades,
        COUNT(*) FILTER (WHERE status = 'closed' AND pnl > 0) AS wins,
        COUNT(*) FILTER (WHERE status = 'closed' AND pnl <= 0) AS losses,
        ROUND(SUM(pnl) FILTER (WHERE status = 'closed')::numeric, 2) AS total_pnl,
        ROUND(AVG(pnl) FILTER (WHERE status = 'closed')::numeric, 3) AS avg_pnl,
        ROUND(AVG(pnl_pct) FILTER (WHERE status = 'closed')::numeric, 3) AS avg_pnl_pct,
        MAX(pnl) AS best_trade,
        MIN(pnl) AS worst_trade
      FROM trades
      WHERE opened_at >= $1
      GROUP BY strategy_name
      ORDER BY total_pnl DESC NULLS LAST
    `, [since]);

    console.log('\n===== POR ESTRATÉGIA (desde ' + since + ') =====');
    console.table(byStrategy.rows.map(r => ({
      estrategia: r.strategy_name,
      trades: r.total_trades,
      fechados: r.closed_trades,
      abertos: r.open_trades,
      wins: r.wins,
      losses: r.losses,
      winRate: r.closed_trades > 0 ? ((r.wins / r.closed_trades) * 100).toFixed(1) + '%' : '-',
      pnlTotal: r.total_pnl,
      pnlMedio: r.avg_pnl,
      pnlPctMedio: r.avg_pnl_pct,
      melhor: r.best_trade,
      pior: r.worst_trade,
    })));

    const openPos = await client.query(`
      SELECT strategy_name, symbol, side, entry_price, quantity, opened_at
      FROM trades WHERE status = 'open' AND opened_at >= $1
      ORDER BY opened_at DESC
    `, [since]);
    console.log('\n===== POSIÇÕES AINDA ABERTAS (desde ' + since + ') =====');
    console.table(openPos.rows);

    const bySymbol = await client.query(`
      SELECT strategy_name, symbol, COUNT(*) AS n,
        ROUND(SUM(pnl) FILTER (WHERE status='closed')::numeric,2) AS pnl
      FROM trades
      WHERE opened_at >= $1
      GROUP BY strategy_name, symbol
      ORDER BY pnl ASC NULLS LAST
      LIMIT 15
    `, [since]);
    console.log('\n===== PIORES 15 (estrategia+simbolo) =====');
    console.table(bySymbol.rows);

    const bySymbolTop = await client.query(`
      SELECT strategy_name, symbol, COUNT(*) AS n,
        ROUND(SUM(pnl) FILTER (WHERE status='closed')::numeric,2) AS pnl
      FROM trades
      WHERE opened_at >= $1
      GROUP BY strategy_name, symbol
      ORDER BY pnl DESC NULLS LAST
      LIMIT 15
    `, [since]);
    console.log('\n===== MELHORES 15 (estrategia+simbolo) =====');
    console.table(bySymbolTop.rows);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
