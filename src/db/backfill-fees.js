// Recalcula, uma única vez, o PnL dos trades já fechados antes de o cálculo
// passar a descontar comissão (ver services/runner.js, TAKER_FEE_RATE).
// Idempotente: só mexe em trades fechados com fee=0 (o valor por omissão da
// coluna), por isso correr duas vezes não desconta a comissão em duplicado.
require('dotenv').config();
const { Pool } = require('pg');

const TAKER_FEE_RATE = 0.00055;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function backfill() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee DECIMAL(20,8) DEFAULT 0`);

    const { rows } = await client.query(
      `SELECT id, entry_price, exit_price, quantity, pnl FROM trades WHERE status='closed' AND fee=0`
    );
    console.log(`${rows.length} trade(s) fechado(s) sem comissão registada — a recalcular...`);

    let updated = 0;
    for (const t of rows) {
      const entryPrice = parseFloat(t.entry_price);
      const exitPrice = parseFloat(t.exit_price);
      const qty = parseFloat(t.quantity);
      const oldPnl = parseFloat(t.pnl);
      const fee = (entryPrice * qty + exitPrice * qty) * TAKER_FEE_RATE;
      const newPnl = oldPnl - fee;
      await client.query(`UPDATE trades SET pnl=$1, fee=$2 WHERE id=$3`, [newPnl, fee, t.id]);
      updated++;
    }
    console.log(`${updated} trade(s) atualizado(s) com PnL líquido de comissão.`);

    // winning_trades/win_rate em strategy_stats podem ter ficado desatualizados
    // se algum trade passou de lucro a prejuízo depois de descontar a comissão.
    const { rows: groups } = await client.query(`
      SELECT strategy_name, symbol,
        COUNT(*) FILTER (WHERE status='closed') as total_closed,
        COUNT(*) FILTER (WHERE status='closed' AND pnl > 0) as wins
      FROM trades
      GROUP BY strategy_name, symbol
    `);
    for (const g of groups) {
      const totalClosed = parseInt(g.total_closed);
      if (totalClosed === 0) continue;
      const winRate = (parseInt(g.wins) / totalClosed) * 100;
      await client.query(
        `UPDATE strategy_stats SET winning_trades=$1, win_rate=$2, updated_at=NOW()
         WHERE strategy_name=$3 AND symbol=$4`,
        [g.wins, winRate, g.strategy_name, g.symbol]
      );
    }
    console.log(`strategy_stats recalculado para ${groups.length} par(es) estratégia/símbolo.`);
  } finally {
    client.release();
    await pool.end();
  }
}

backfill().catch(err => { console.error('Erro no backfill:', err); process.exit(1); });
