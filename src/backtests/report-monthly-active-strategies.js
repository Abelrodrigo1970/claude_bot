// Resumo mensal de resultados REAIS (trades de papel/produção, tabela
// `trades`) das estratégias atualmente ativas (enabled=true) — via API
// pública da app (não precisa de acesso direto à BD, só do URL do deploy).
//
// Corre com: node src/backtests/report-monthly-active-strategies.js [base-url]
// Ex.: node src/backtests/report-monthly-active-strategies.js https://claudebot-production-d67d.up.railway.app
const https = require('https');
const http = require('http');

const BASE_URL = (process.argv[2] || 'https://claudebot-production-d67d.up.railway.app').replace(/\/$/, '');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

function monthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  console.log(`A consultar ${BASE_URL} ...\n`);
  const strategies = await fetchJson(`${BASE_URL}/api/strategies`);
  const active = strategies.filter(s => s.enabled);

  if (!active.length) {
    console.log('Nenhuma estratégia ativa (enabled=true) neste momento.');
    return;
  }
  console.log(`Estratégias ativas: ${active.map(s => s.name).join(', ')}\n`);

  for (const strat of active) {
    const trades = await fetchJson(`${BASE_URL}/api/trades?strategy=${encodeURIComponent(strat.name)}&limit=5000`);
    console.log('════════════════════════════════════════════════════════');
    console.log(`${strat.name}  (${strat.market}, ${strat.timeframe}, ${strat.symbolCount} símbolos) — ${trades.length} trades no total`);
    console.log('════════════════════════════════════════════════════════');

    if (!trades.length) { console.log('Sem trades ainda.\n'); continue; }

    // Agrupa por mês de FECHO (closed_at) — trades ainda abertos entram
    // num grupo "em aberto" à parte, não contam para o PnL realizado do mês.
    const byMonth = {};
    let openTrades = [];
    for (const t of trades) {
      if (t.status !== 'closed' || !t.closed_at) { openTrades.push(t); continue; }
      const key = monthKey(t.closed_at);
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(t);
    }

    const months = Object.keys(byMonth).sort();
    const rows = months.map(m => {
      const ts = byMonth[m];
      const wins = ts.filter(t => parseFloat(t.pnl) > 0);
      const losses = ts.filter(t => parseFloat(t.pnl) <= 0);
      const totalPnl = ts.reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
      const totalFee = ts.reduce((a, t) => a + parseFloat(t.fee || 0), 0);
      const winRate = ts.length ? (wins.length / ts.length) * 100 : 0;
      const best = ts.reduce((a, t) => Math.max(a, parseFloat(t.pnl || 0)), -Infinity);
      const worst = ts.reduce((a, t) => Math.min(a, parseFloat(t.pnl || 0)), Infinity);
      return {
        mes: m, trades: ts.length, wins: wins.length, losses: losses.length,
        winRate: winRate.toFixed(1) + '%',
        pnlTotal: totalPnl.toFixed(2),
        pnlMedio: (totalPnl / ts.length).toFixed(3),
        fees: totalFee.toFixed(2),
        melhor: best.toFixed(2), pior: worst.toFixed(2),
      };
    });
    console.table(rows);

    const grandTotal = months.reduce((a, m) => a + byMonth[m].reduce((s, t) => s + parseFloat(t.pnl || 0), 0), 0);
    console.log(`Total realizado (todos os meses): ${grandTotal >= 0 ? '+' : ''}${grandTotal.toFixed(2)} USDT`);
    if (openTrades.length) {
      console.log(`Posições ainda abertas: ${openTrades.length} (não contam para o PnL realizado acima)`);
    }
    console.log('');
  }
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
