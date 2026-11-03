import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { format, startOfDay, startOfMonth, subDays } from 'date-fns';

const DATE_PRESETS = [
  { label: 'Hoje',      key: 'today' },
  { label: '7 dias',    key: '7' },
  { label: '30 dias',   key: '30' },
  { label: 'Este mês',  key: 'month' },
  { label: 'Tudo',      key: 'all' },
];
const LIST_LIMIT = 2000;

const selectStyle = {
  background: 'var(--bg3)', border: '1px solid var(--border)',
  color: 'var(--text)', padding: '6px 10px', borderRadius: 6,
  fontSize: 12, outline: 'none', cursor: 'pointer',
};
const inputStyle = { ...selectStyle, width: 130 };

const fmtUsdt = (v, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
const isChild = (t) => t.metadata && t.metadata.parentTradeId != null;

export default function Trades() {
  const [trades, setTrades] = useState([]);
  const [summary, setSummary] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [status, setStatus] = useState('all');
  const [strategy, setStrategy] = useState('');
  const [dateField, setDateField] = useState('closed');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');

  useEffect(() => {
    axios.get('/api/trades/strategies').then(({ data }) => setStrategies(data)).catch(() => {});
  }, []);

  function applyPreset(key) {
    setPreset(key);
    const now = new Date();
    if (key === 'all') { setFrom(''); setTo(''); return; }
    const start = key === 'today' ? startOfDay(now) : key === 'month' ? startOfMonth(now) : subDays(now, Number(key));
    setFrom(format(start, 'yyyy-MM-dd'));
    setTo(format(now, 'yyyy-MM-dd'));
  }

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      const q = new URLSearchParams();
      if (strategy) q.set('strategy', strategy);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      const list = new URLSearchParams(q);
      list.set('limit', String(LIST_LIMIT));
      list.set('dateField', dateField);
      if (status !== 'all') list.set('status', status);
      try {
        const [t, s] = await Promise.all([axios.get(`/api/trades?${list}`), axios.get(`/api/trades/summary?${q}`)]);
        setTrades(t.data);
        setSummary(s.data);
      } catch (e) {
        setError(e.response?.data?.error || e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [status, strategy, dateField, from, to]);

  const totals = useMemo(() => {
    const t = summary.reduce(
      (a, r) => ({
        pnl: a.pnl + r.pnl, fees: a.fees + r.fees, trades: a.trades + r.trades, wins: a.wins + r.wins,
        open: a.open + r.open_trades, pctSum: a.pctSum + (r.avg_pct ?? 0) * r.trades,
      }),
      { pnl: 0, fees: 0, trades: 0, wins: 0, open: 0, pctSum: 0 },
    );
    return { ...t, winRate: t.trades ? (t.wins / t.trades) * 100 : null, avgPct: t.trades ? t.pctSum / t.trades : null };
  }, [summary]);

  const periodLabel = from || to ? `${from ? format(new Date(`${from}T00:00`), 'dd/MM/yyyy') : 'início'} → ${to ? format(new Date(`${to}T00:00`), 'dd/MM/yyyy') : 'hoje'}` : 'todo o histórico';
  const hasFilters = strategy || from || to || status !== 'all';

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Histórico de Trades</div>
          <div className="page-sub">
            Resultados de {strategy || 'todas as estratégias'} · {periodLabel} (datas de fecho, hora de Lisboa)
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select style={selectStyle} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="">Todas as estratégias</option>
            {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select style={selectStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Todos</option>
            <option value="open">Abertos</option>
            <option value="closed">Fechados</option>
          </select>

          <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 4px' }} />

          {DATE_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              style={{
                ...selectStyle,
                background: preset === p.key ? 'var(--blue)' : 'var(--bg3)',
                color: preset === p.key ? '#fff' : 'var(--muted)',
                border: `1px solid ${preset === p.key ? 'var(--blue)' : 'var(--border)'}`,
              }}
            >
              {p.label}
            </button>
          ))}
          <input type="date" style={inputStyle} value={from} onChange={(e) => { setFrom(e.target.value); setPreset(null); }} title="Data de início" />
          <span className="muted" style={{ fontSize: 12 }}>→</span>
          <input type="date" style={inputStyle} value={to} onChange={(e) => { setTo(e.target.value); setPreset(null); }} title="Data de fim" />

          <select style={selectStyle} value={dateField} onChange={(e) => setDateField(e.target.value)} title="Data usada na lista de trades">
            <option value="closed">Lista por data de fecho</option>
            <option value="opened">Lista por data de abertura</option>
          </select>

          {hasFilters && (
            <button
              onClick={() => { setStrategy(''); setStatus('all'); applyPreset('all'); }}
              style={{ ...selectStyle, color: 'var(--red)', borderColor: 'var(--red)' }}
            >
              ✕ Limpar
            </button>
          )}
        </div>
      </div>

      {error && <div className="card red" style={{ marginBottom: 20 }}>Erro: {error}</div>}

      {/* Totais do período */}
      <div className="grid-4">
        <div className="card">
          <div className={`stat-value ${totals.pnl >= 0 ? 'green' : 'red'}`}>{fmtUsdt(totals.pnl)} USDT</div>
          <div className="stat-label">PnL realizado (líquido de comissões: {totals.fees.toFixed(2)})</div>
        </div>
        <div className="card">
          <div className="stat-value blue">{totals.trades}</div>
          <div className="stat-label">Trades fechados{totals.open ? ` · ${totals.open} abertos agora` : ''}</div>
        </div>
        <div className="card">
          <div className={`stat-value ${totals.winRate == null ? 'muted' : totals.winRate >= 50 ? 'green' : 'yellow'}`}>
            {totals.winRate == null ? '—' : `${totals.winRate.toFixed(1)}%`}
          </div>
          <div className="stat-label">Taxa de acerto ({totals.wins} vencedores)</div>
        </div>
        <div className="card">
          <div className={`stat-value ${totals.avgPct == null ? 'muted' : totals.avgPct >= 0 ? 'green' : 'red'}`}>
            {totals.avgPct == null ? '—' : `${fmtUsdt(totals.avgPct)}%`}
          </div>
          <div className="stat-label">Média por trade (sobre o valor investido)</div>
        </div>
      </div>

      {/* Resultados por estratégia */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Resultados por estratégia</div>
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : summary.length === 0 ? (
          <div className="empty">Sem trades fechados neste período</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Estratégia</th>
                  <th>Trades</th>
                  <th>Acerto</th>
                  <th>PnL (USDT)</th>
                  <th>Média %</th>
                  <th>Melhor</th>
                  <th>Pior</th>
                  <th>Parciais</th>
                  <th>Abertos</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.strategy_name} style={{ cursor: 'pointer' }} onClick={() => setStrategy(r.strategy_name === strategy ? '' : r.strategy_name)} title="Filtrar por esta estratégia">
                    <td style={{ color: r.strategy_name === strategy ? 'var(--green)' : undefined }}>{r.strategy_name}</td>
                    <td>{r.trades}</td>
                    <td className={r.trades ? (r.wins / r.trades >= 0.5 ? 'green' : 'yellow') : 'muted'}>
                      {r.trades ? `${((r.wins / r.trades) * 100).toFixed(1)}% (${r.wins}/${r.trades})` : '—'}
                    </td>
                    <td className={r.pnl >= 0 ? 'green' : 'red'}>{fmtUsdt(r.pnl, 4)}</td>
                    <td className={r.avg_pct == null ? 'muted' : r.avg_pct >= 0 ? 'green' : 'red'}>{r.avg_pct == null ? '—' : `${fmtUsdt(r.avg_pct)}%`}</td>
                    <td className="green">{r.best == null ? '—' : fmtUsdt(r.best, 4)}</td>
                    <td className="red">{r.worst == null ? '—' : fmtUsdt(r.worst, 4)}</td>
                    <td className="muted">{r.partials || '—'}</td>
                    <td className="muted">{r.open_trades || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              PnL = tudo o que foi realizado no período, incluindo take-profits parciais. Trades, acerto, média, melhor e pior
              contam cada posição fechada no período uma vez, com o resultado total (parciais incluídas, mesmo que anteriores).
            </div>
          </div>
        )}
      </div>

      {/* Lista de trades */}
      <div className="card">
        <div className="card-title">
          Trades ({trades.length}{trades.length >= LIST_LIMIT ? ` — mostra os ${LIST_LIMIT} mais recentes; reduza o período` : ''})
        </div>
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : trades.length === 0 ? (
          <div className="empty">Nenhum trade encontrado</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Estratégia</th>
                  <th>Par</th>
                  <th>Side</th>
                  <th>Entrada</th>
                  <th>Saída</th>
                  <th>Qty</th>
                  <th>PnL (USDT)</th>
                  <th>PnL %</th>
                  <th>Status</th>
                  <th>Aberto</th>
                  <th>Fechado</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const pnl = parseFloat(t.pnl || 0);
                  const pnlPct = parseFloat(t.pnl_pct || 0);
                  return (
                    <tr key={t.id}>
                      <td className="muted">{t.id}{isChild(t) && <span title={`Take-profit parcial do trade #${t.metadata.parentTradeId}`}> ↳</span>}</td>
                      <td>{t.strategy_name}</td>
                      <td style={{ color: '#e2e8f0' }}>{t.symbol.split('/')[0]}/USDT</td>
                      <td><span className={`badge badge-${t.side}`}>{t.side.toUpperCase()}</span></td>
                      <td>{parseFloat(t.entry_price).toFixed(6)}</td>
                      <td>{t.exit_price ? parseFloat(t.exit_price).toFixed(6) : <span className="muted">—</span>}</td>
                      <td className="muted">{parseFloat(t.quantity).toFixed(2)}</td>
                      <td className={pnl >= 0 ? 'green' : 'red'}>
                        {t.status === 'closed' ? fmtUsdt(pnl, 4) : <span className="muted">—</span>}
                      </td>
                      <td className={pnlPct >= 0 ? 'green' : 'red'}>
                        {t.status === 'closed' ? `${fmtUsdt(pnlPct)}%` : <span className="muted">—</span>}
                      </td>
                      <td><span className={`badge badge-${t.status}`}>{t.status}</span></td>
                      <td className="muted">{format(new Date(t.opened_at), 'dd/MM/yy HH:mm')}</td>
                      <td className="muted">{t.closed_at ? format(new Date(t.closed_at), 'dd/MM/yy HH:mm') : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
