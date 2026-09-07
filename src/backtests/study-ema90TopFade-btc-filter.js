// Estudo pedido pelo utilizador (07/09/2026): a EMA90TopFade só deve operar
// (entrar em short) quando o BTC está "negativo"? Mesma lógica do filtro QQQ
// que já existe na estratégia (ver src/strategies/ema90TopFade.js: o short só
// tem edge com o Nasdaq a cair), mas testada contra o BTC.
//
// Usa os trades REAIS fechados da EMA90TopFade (API) + velas diárias do BTC.
// Para cada short, classifica o regime BTC no dia da ENTRADA (opened_at) por
// várias definições de "negativo" e compara o PnL.
//
// Corre com: node src/backtests/study-ema90TopFade-btc-filter.js [base-url]
const ccxt = require('ccxt');
const { EMA } = require('technicalindicators');
const https = require('https');

const BASE_URL = (process.argv[2] || 'https://claudebot-production-d67d.up.railway.app').replace(/\/$/, '');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const n = x => parseFloat(x || 0);
const dayStr = s => new Date(s).toISOString().slice(0, 10);

function summarize(trades) {
  const wins = trades.filter(t => n(t.pnl) > 0);
  const pnl = trades.reduce((a, t) => a + n(t.pnl), 0);
  return {
    n: trades.length,
    wins: wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnl,
    avg: trades.length ? pnl / trades.length : 0,
    best: trades.reduce((a, t) => Math.max(a, n(t.pnl)), trades.length ? -Infinity : 0),
    worst: trades.reduce((a, t) => Math.min(a, n(t.pnl)), trades.length ? Infinity : 0),
  };
}

function fmt(s) {
  return {
    trades: s.n,
    'W/L': `${s.wins}/${s.n - s.wins}`,
    winRate: s.n ? s.winRate.toFixed(0) + '%' : '-',
    pnlUSDT: (s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2),
    médio: s.n ? (s.avg >= 0 ? '+' : '') + s.avg.toFixed(3) : '-',
    melhor: s.n ? s.best.toFixed(2) : '-',
    pior: s.n ? s.worst.toFixed(2) : '-',
  };
}

async function main() {
  console.log(`A obter trades da EMA90TopFade de ${BASE_URL} ...`);
  const all = await fetchJson(`${BASE_URL}/api/trades?strategy=EMA90TopFade&limit=5000`);
  const closed = all.filter(t => t.status === 'closed' && t.closed_at);
  const shorts = closed.filter(t => t.side === 'short');
  const longs = closed.filter(t => t.side === 'long');
  console.log(`${closed.length} fechados · ${shorts.length} shorts · ${longs.length} longs`);
  const opened = closed.map(t => +new Date(t.opened_at)).sort((a, b) => a - b);
  const firstDay = new Date(opened[0]);

  // ── velas diárias do BTC ──────────────────────────────────────
  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();
  const ohlcv = await exchange.fetchOHLCV('BTC/USDT:USDT', '1d', undefined, 400);
  const btc = ohlcv.map(([t, o, h, l, c, v]) => ({ day: new Date(t).toISOString().slice(0, 10), o, h, l, c }));
  const closes = btc.map(b => b.c);
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const byDay = {};
  btc.forEach((b, i) => {
    const e50 = ema50[i - (closes.length - ema50.length)];
    const e200 = ema200[i - (closes.length - ema200.length)];
    byDay[b.day] = {
      ...b,
      prevClose: i > 0 ? btc[i - 1].c : null,
      close7ago: i >= 7 ? btc[i - 7].c : null,
      ema50: e50 ?? null,
      ema200: e200 ?? null,
    };
  });

  // definições de "BTC negativo" no dia da entrada
  const DEFS = {
    'vela vermelha (close<open)':        d => d && d.c < d.o,
    'fecho < fecho da véspera':          d => d && d.prevClose != null && d.c < d.prevClose,
    'abaixo da EMA50 diária':            d => d && d.ema50 != null && d.c < d.ema50,
    'abaixo da EMA200 diária':           d => d && d.ema200 != null && d.c < d.ema200,
    'retorno 7d negativo':               d => d && d.close7ago != null && d.c < d.close7ago,
  };

  const regimeOf = (t) => byDay[dayStr(t.opened_at)];

  console.log('\n════════════════════════════════════════════════════════');
  console.log('SHORTS — PnL conforme o regime do BTC no dia da entrada');
  console.log('(BTC negativo = manter a trade · BTC positivo = a trade seria bloqueada)');
  console.log('════════════════════════════════════════════════════════');
  for (const [label, fn] of Object.entries(DEFS)) {
    const neg = shorts.filter(t => fn(regimeOf(t)));
    const pos = shorts.filter(t => !fn(regimeOf(t)));
    console.log(`\n▸ "${label}"`);
    console.table({
      'BTC negativo (opera)': fmt(summarize(neg)),
      'BTC positivo (bloqueia)': fmt(summarize(pos)),
    });
  }

  // ── longs (lado comprador, flip ao sair do top 8) para contexto ──
  console.log('\n════════════════════════════════════════════════════════');
  console.log('LONGS (flip ao sair do top 8) — mesmo corte, para contexto');
  console.log('════════════════════════════════════════════════════════');
  {
    const fn = DEFS['abaixo da EMA50 diária'];
    console.table({
      'BTC negativo': fmt(summarize(longs.filter(t => fn(regimeOf(t))))),
      'BTC positivo': fmt(summarize(longs.filter(t => !fn(regimeOf(t))))),
    });
  }

  // ── resultado combinado: o que "só operar com BTC negativo" faria ──
  console.log('\n════════════════════════════════════════════════════════');
  console.log('RESULTADO SE A ESTRATÉGIA SÓ OPERASSE COM BTC NEGATIVO');
  console.log('(remove shorts abertos em dias de BTC positivo; longs seguem o mesmo corte)');
  console.log('════════════════════════════════════════════════════════');
  const rows = Object.entries(DEFS).map(([label, fn]) => {
    const sN = summarize(shorts.filter(t => fn(regimeOf(t))));
    const sAll = summarize(shorts);
    return {
      'definição BTC negativo': label,
      'shorts mantidos': `${sN.n}/${sAll.n}`,
      'PnL shorts (filtrado)': (sN.pnl >= 0 ? '+' : '') + sN.pnl.toFixed(2),
      'PnL shorts (atual)': (sAll.pnl >= 0 ? '+' : '') + sAll.pnl.toFixed(2),
      'Δ': ((sN.pnl - sAll.pnl) >= 0 ? '+' : '') + (sN.pnl - sAll.pnl).toFixed(2),
    };
  });
  console.table(rows);

  // ── dia-a-dia (como a nota do filtro QQQ no cabeçalho da estratégia) ──
  console.log('\n════════════════════════════════════════════════════════');
  console.log('DIA-A-DIA — PnL dos shorts abertos em cada dia vs direção do BTC nesse dia');
  console.log('════════════════════════════════════════════════════════');
  const shortsByDay = {};
  for (const t of shorts) (shortsByDay[dayStr(t.opened_at)] ||= []).push(t);
  let daysRedPnl = 0, daysGreenPnl = 0, nRed = 0, nGreen = 0;
  for (const day of Object.keys(shortsByDay).sort()) {
    const d = byDay[day];
    const p = shortsByDay[day].reduce((a, t) => a + n(t.pnl), 0);
    const red = d && d.c < d.o;
    if (red) { daysRedPnl += p; nRed++; } else { daysGreenPnl += p; nGreen++; }
  }
  console.log(`Dias com BTC vermelho: ${nRed} → shorts abertos nesses dias somam ${daysRedPnl >= 0 ? '+' : ''}${daysRedPnl.toFixed(2)} USDT`);
  console.log(`Dias com BTC verde:    ${nGreen} → shorts abertos nesses dias somam ${daysGreenPnl >= 0 ? '+' : ''}${daysGreenPnl.toFixed(2)} USDT`);
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
