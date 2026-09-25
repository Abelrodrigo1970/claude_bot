/**
 * Estudo: performance real das estratégias do Cripto Bot nos últimos N dias.
 * Fonte: API pública da app (tabela trades via /api/trades).
 *
 * Uso:
 *   node src/backtests/study-strategies-last-days.js
 *   node src/backtests/study-strategies-last-days.js 30
 *   node src/backtests/study-strategies-last-days.js 30 https://claudebot-production-d67d.up.railway.app
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DAYS = parseInt(process.argv[2], 10) || 30;
const BASE_URL = (process.argv[3] || 'https://claudebot-production-d67d.up.railway.app').replace(/\/$/, '');
const OUT = path.join(__dirname, 'out-strategies-last-days.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

const n = (x) => parseFloat(x || 0);

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  const open = trades.filter((t) => t.status === 'open');
  const wins = closed.filter((t) => n(t.pnl) > 0);
  const losses = closed.filter((t) => n(t.pnl) <= 0);
  const pnl = closed.reduce((a, t) => a + n(t.pnl), 0);
  const fees = closed.reduce((a, t) => a + n(t.fee), 0);
  const grossWin = wins.reduce((a, t) => a + n(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + n(t.pnl), 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  return {
    total: trades.length,
    closed: closed.length,
    open: open.length,
    wins: wins.length,
    losses: losses.length,
    wr: closed.length ? (wins.length / closed.length) * 100 : 0,
    pnl,
    fees,
    pf,
    best: closed.length ? Math.max(...closed.map((t) => n(t.pnl))) : 0,
    worst: closed.length ? Math.min(...closed.map((t) => n(t.pnl))) : 0,
    avgPnl: closed.length ? pnl / closed.length : 0,
  };
}

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  console.log(`A consultar ${BASE_URL} · últimos ${DAYS}d (desde ${since.toISOString()})...\n`);

  const [stratMeta, allTrades] = await Promise.all([
    fetchJson(`${BASE_URL}/api/strategies`).catch(() => []),
    fetchJson(`${BASE_URL}/api/trades?limit=50000`),
  ]);
  const enabledMap = Object.fromEntries((stratMeta || []).map((s) => [s.name, s.enabled]));

  const windowTrades = (allTrades || []).filter((t) => {
    const opened = t.opened_at ? new Date(t.opened_at).getTime() : 0;
    return opened >= since.getTime();
  });

  const byName = {};
  for (const t of windowTrades) {
    (byName[t.strategy_name] ||= []).push(t);
  }

  const rows = Object.entries(byName)
    .map(([name, trades]) => {
      const s = summarize(trades);
      return {
        name,
        enabled: enabledMap[name] === true,
        ...s,
      };
    })
    .sort((a, b) => b.pnl - a.pnl);

  const totals = summarize(windowTrades);

  // top/bottom trades closed
  const closedAll = windowTrades
    .filter((t) => t.status === 'closed')
    .map((t) => ({
      strategy: t.strategy_name,
      symbol: t.symbol,
      side: t.side,
      pnl: n(t.pnl),
      pnlPct: n(t.pnl_pct),
      opened: t.opened_at,
      closed: t.closed_at,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const payload = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    since: since.toISOString(),
    baseUrl: BASE_URL,
    totals: {
      ...totals,
      wr: Number(totals.wr.toFixed(1)),
      pnl: Number(totals.pnl.toFixed(2)),
      fees: Number(totals.fees.toFixed(2)),
      pf: totals.pf === Infinity ? null : Number(totals.pf.toFixed(2)),
    },
    strategies: rows.map((r) => ({
      ...r,
      wr: Number(r.wr.toFixed(1)),
      pnl: Number(r.pnl.toFixed(2)),
      fees: Number(r.fees.toFixed(2)),
      pf: r.pf === Infinity ? null : Number(r.pf.toFixed(2)),
      avgPnl: Number(r.avgPnl.toFixed(2)),
      best: Number(r.best.toFixed(2)),
      worst: Number(r.worst.toFixed(2)),
    })),
    top10: closedAll.slice(0, 10),
    worst10: closedAll.slice(-10).reverse(),
    registry: (stratMeta || []).map((s) => ({
      name: s.name,
      enabled: s.enabled,
      timeframe: s.timeframe,
      positionSize: s.positionSize,
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('════════════════════════════════════════════════════════');
  console.log(`Cripto Bot · trades reais · últimos ${DAYS} dias`);
  console.log('════════════════════════════════════════════════════════');
  console.log(
    `Total: ${totals.total} trades · fechados ${totals.closed} · abertos ${totals.open} · PnL ${totals.pnl.toFixed(2)} · WR ${totals.wr.toFixed(1)}%`
  );
  console.log('\nPor estratégia (ordenado por PnL fechado):');
  console.table(
    rows.map((r) => ({
      on: r.enabled ? '✓' : '·',
      estrategia: r.name,
      n: r.total,
      fech: r.closed,
      ab: r.open,
      wr: r.closed ? r.wr.toFixed(1) + '%' : '-',
      pnl: (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2),
      pf: r.pf === Infinity ? '∞' : r.pf.toFixed(2),
      avg: r.avgPnl.toFixed(2),
      best: r.best.toFixed(2),
      worst: r.worst.toFixed(2),
    }))
  );

  console.log('\nRegistry atual (API /api/strategies):');
  console.table(
    (stratMeta || []).map((s) => ({
      on: s.enabled ? '✓' : '·',
      name: s.name,
      tf: s.timeframe,
      size: s.positionSize,
    }))
  );

  console.log('\nTOP 10 trades:');
  console.table(
    payload.top10.map((t) => ({
      strat: t.strategy,
      symbol: (t.symbol || '').split('/')[0],
      side: t.side,
      pnl: t.pnl.toFixed(2),
      opened: (t.opened || '').slice(0, 16),
    }))
  );
  console.log('\nBOTTOM 10 trades:');
  console.table(
    payload.worst10.map((t) => ({
      strat: t.strategy,
      symbol: (t.symbol || '').split('/')[0],
      side: t.side,
      pnl: t.pnl.toFixed(2),
      opened: (t.opened || '').slice(0, 16),
    }))
  );

  console.log(`\nJSON → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
