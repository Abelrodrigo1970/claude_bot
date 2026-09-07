// Resumo MENSAL de resultados reais (tabela `trades`, papel/produção) de
// TODAS as estratégias com trades — não só as enabled=true. Meses fixos:
// junho, julho, agosto e setembro de 2026 (mostra a coluna mesmo com 0
// trades). Agrupa pelo mês de FECHO (closed_at); trades ainda abertos
// entram só na contagem de "abertas".
//
// Só usa a API pública da app (ver reference_deployed_api na memória) —
// não precisa de acesso direto à BD.
//
// Corre com: node src/backtests/report-monthly-all-strategies.js [base-url]
const https = require('https');
const http = require('http');

const BASE_URL = (process.argv[2] || 'https://claudebot-production-d67d.up.railway.app').replace(/\/$/, '');
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09'];
const MONTH_LABEL = { '2026-06': 'jun', '2026-07': 'jul', '2026-08': 'ago', '2026-09': 'set' };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const monthKey = (s) => {
  const d = new Date(s);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const n = (x) => parseFloat(x || 0);

function statsOf(ts) {
  const wins = ts.filter(t => n(t.pnl) > 0);
  const pnl = ts.reduce((a, t) => a + n(t.pnl), 0);
  const fees = ts.reduce((a, t) => a + n(t.fee), 0);
  return {
    trades: ts.length, wins: wins.length, losses: ts.length - wins.length,
    winRate: ts.length ? (wins.length / ts.length) * 100 : 0,
    pnl, fees,
    best: ts.reduce((a, t) => Math.max(a, n(t.pnl)), ts.length ? -Infinity : 0),
    worst: ts.reduce((a, t) => Math.min(a, n(t.pnl)), ts.length ? Infinity : 0),
  };
}

async function main() {
  console.log(`A consultar ${BASE_URL} ...\n`);
  const [stratMeta, allTrades] = await Promise.all([
    fetchJson(`${BASE_URL}/api/strategies`).catch(() => []),
    fetchJson(`${BASE_URL}/api/trades?limit=50000`),
  ]);
  const enabledMap = Object.fromEntries((stratMeta || []).map(s => [s.name, s.enabled]));

  // agrupa: strategy -> { closedByMonth, open[] }
  const g = {};
  for (const t of allTrades) {
    const k = t.strategy_name;
    if (!g[k]) g[k] = { closedByMonth: {}, open: [], allClosed: [] };
    if (t.status === 'closed' && t.closed_at) {
      const m = monthKey(t.closed_at);
      (g[k].closedByMonth[m] ||= []).push(t);
      g[k].allClosed.push(t);
    } else if (t.status === 'open') {
      g[k].open.push(t);
    }
  }

  const names = Object.keys(g).sort((a, b) => {
    const pa = g[a].allClosed.reduce((s, t) => s + n(t.pnl), 0);
    const pb = g[b].allClosed.reduce((s, t) => s + n(t.pnl), 0);
    return pb - pa;
  });

  console.log(`Estratégias com trades: ${names.length}  (✓ = enabled agora)\n`);

  // ── por estratégia ──────────────────────────────────────────────
  for (const name of names) {
    const on = enabledMap[name] === true ? '✓' : enabledMap[name] === false ? '·' : '?';
    const total = g[name].allClosed.reduce((s, t) => s + n(t.pnl), 0);
    console.log('════════════════════════════════════════════════════════');
    console.log(`${on} ${name} — ${g[name].allClosed.length} fechados · ${g[name].open.length} abertas · total realizado ${total >= 0 ? '+' : ''}${total.toFixed(2)} USDT`);
    console.log('════════════════════════════════════════════════════════');
    const rows = MONTHS.map(m => {
      const s = statsOf(g[name].closedByMonth[m] || []);
      return {
        mes: MONTH_LABEL[m],
        trades: s.trades,
        'W/L': `${s.wins}/${s.losses}`,
        winRate: s.trades ? s.winRate.toFixed(0) + '%' : '-',
        pnlUSDT: s.trades ? (s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2) : '-',
        pnlMedio: s.trades ? (s.pnl / s.trades).toFixed(2) : '-',
        fees: s.trades ? s.fees.toFixed(2) : '-',
        melhor: s.trades ? s.best.toFixed(2) : '-',
        pior: s.trades ? s.worst.toFixed(2) : '-',
      };
    });
    console.table(rows);
  }

  // ── matriz PnL: estratégia × mês ───────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log('MATRIZ — PnL realizado (USDT) por estratégia e mês');
  console.log('════════════════════════════════════════════════════════');
  const matrix = names.map(name => {
    const row = { estrategia: (enabledMap[name] ? '✓ ' : '  ') + name };
    let tot = 0;
    for (const m of MONTHS) {
      const p = (g[name].closedByMonth[m] || []).reduce((a, t) => a + n(t.pnl), 0);
      const has = (g[name].closedByMonth[m] || []).length > 0;
      row[MONTH_LABEL[m]] = has ? (p >= 0 ? '+' : '') + p.toFixed(1) : '-';
      tot += p;
    }
    row.total = (tot >= 0 ? '+' : '') + tot.toFixed(1);
    return row;
  });
  // linha de total por mês
  const totalRow = { estrategia: 'TOTAL' };
  let grand = 0;
  for (const m of MONTHS) {
    const p = names.reduce((a, name) => a + (g[name].closedByMonth[m] || []).reduce((s, t) => s + n(t.pnl), 0), 0);
    totalRow[MONTH_LABEL[m]] = (p >= 0 ? '+' : '') + p.toFixed(1);
    grand += p;
  }
  totalRow.total = (grand >= 0 ? '+' : '') + grand.toFixed(1);
  matrix.push(totalRow);
  console.table(matrix);

  // ── trades por mês (contagem) ─────────────────────────────────
  console.log('\nContagem de trades fechados por mês:');
  const countRow = { '': 'trades' };
  for (const m of MONTHS) {
    countRow[MONTH_LABEL[m]] = names.reduce((a, name) => a + (g[name].closedByMonth[m] || []).length, 0);
  }
  console.table([countRow]);

  const totalOpen = names.reduce((a, name) => a + g[name].open.length, 0);
  console.log(`\nPosições ainda abertas (todas as estratégias): ${totalOpen} — não contam para o PnL realizado acima.`);
  console.log('Nota: agrupado pelo mês de FECHO (closed_at). PnL já líquido de fees.');
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
