import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { format } from 'date-fns';

export default function Dashboard() {
  const [stats, setStats] = useState([]);
  const [pnl, setPnl] = useState([]);
  const [trades, setTrades] = useState([]);
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    const safe = async (fn, setter) => {
      try { setter((await fn()).data); } catch { /* BD pode não estar configurada ainda */ }
    };
    await Promise.all([
      safe(() => axios.get('/api/stats'),            setStats),
      safe(() => axios.get('/api/pnl/daily'),        setPnl),
      safe(() => axios.get('/api/trades?limit=5'),   setTrades),
      safe(() => axios.get('/api/signals?limit=5'),  setSignals),
    ]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try { await axios.post('/api/run'); await load(); }
    finally { setRunning(false); }
  };

  const totalPnl = stats.reduce((acc, s) => acc + parseFloat(s.total_pnl_calc || 0), 0);
  const totalTrades = stats.reduce((acc, s) => acc + parseInt(s.total_trades || 0), 0);
  const openTrades = stats.reduce((acc, s) => acc + parseInt(s.open_trades || 0), 0);
  const avgWinRate = stats.length ? stats.reduce((a, s) => a + parseFloat(s.win_rate || 0), 0) / stats.length : 0;

  // Acumula PnL para o gráfico
  let cumulative = 0;
  const chartData = pnl.map(d => {
    cumulative += parseFloat(d.daily_pnl || 0);
    return { date: d.date, pnl: parseFloat(d.daily_pnl || 0), cumulative: parseFloat(cumulative.toFixed(4)) };
  });

  const signalColor = (type) => {
    if (type?.includes('long') || type === 'flip_to_long') return 'long';
    if (type?.includes('short') || type === 'flip_to_short') return 'short';
    if (type?.includes('flip')) return 'flip';
    return 'hold';
  };

  if (loading) return <div className="loading"><div className="spinner" /><span>A carregar...</span></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-sub">Atualiza automaticamente a cada 30s</div>
        </div>
        <button className="btn btn-primary" onClick={handleRun} disabled={running}>
          {running ? '⏳ A executar...' : '▶ Executar Agora'}
        </button>
      </div>

      {/* STAT CARDS */}
      <div className="grid-4">
        <div className="card">
          <div className="card-title">PnL Total</div>
          <div className={`stat-value ${totalPnl >= 0 ? 'green' : 'red'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(4)} USDT
          </div>
          <div className="stat-label">Lucro/Prejuízo acumulado</div>
        </div>
        <div className="card">
          <div className="card-title">Win Rate</div>
          <div className={`stat-value ${avgWinRate >= 50 ? 'green' : 'yellow'}`}>
            {avgWinRate.toFixed(1)}%
          </div>
          <div className="stat-label">Taxa de acerto média</div>
        </div>
        <div className="card">
          <div className="card-title">Trades Totais</div>
          <div className="stat-value blue">{totalTrades}</div>
          <div className="stat-label">{openTrades} abertos agora</div>
        </div>
        <div className="card">
          <div className="card-title">Estratégias Ativas</div>
          <div className="stat-value green">{stats.length}</div>
          <div className="stat-label">A monitorizar 24/7</div>
        </div>
      </div>

      {/* PNL CHART */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Curva de Capital (PnL Acumulado)</div>
        {chartData.length === 0 ? (
          <div className="empty">Sem dados ainda. Aguarda a primeira operação.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00d4a0" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00d4a0" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#252836" />
              <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 11 }} tickFormatter={v => format(new Date(v), 'dd/MM')} />
              <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#13161e', border: '1px solid #252836', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#64748b' }}
                formatter={(v) => [`${v.toFixed(4)} USDT`]}
              />
              <Area type="monotone" dataKey="cumulative" stroke="#00d4a0" strokeWidth={2} fill="url(#pnlGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid-2">
        {/* ÚLTIMOS TRADES */}
        <div className="card">
          <div className="card-title">Últimos Trades</div>
          {trades.length === 0 ? (
            <div className="empty">Sem trades ainda</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Par</th><th>Side</th><th>Entrada</th><th>PnL</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id}>
                      <td>{t.symbol.split('/')[0]}</td>
                      <td><span className={`badge badge-${t.side}`}>{t.side}</span></td>
                      <td>{parseFloat(t.entry_price).toFixed(5)}</td>
                      <td className={parseFloat(t.pnl) >= 0 ? 'green' : 'red'}>
                        {t.pnl ? `${parseFloat(t.pnl) >= 0 ? '+' : ''}${parseFloat(t.pnl).toFixed(4)}` : '—'}
                      </td>
                      <td><span className={`badge badge-${t.status}`}>{t.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ÚLTIMOS SINAIS */}
        <div className="card">
          <div className="card-title">Últimos Sinais</div>
          {signals.length === 0 ? (
            <div className="empty">Sem sinais ainda</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Estratégia</th><th>Sinal</th><th>Preço</th><th>Hora</th></tr>
                </thead>
                <tbody>
                  {signals.map(s => (
                    <tr key={s.id}>
                      <td className="muted">{s.strategy_name}</td>
                      <td>
                        <span className={`signal-dot ${signalColor(s.signal_type)}`} />
                        <span className={`badge badge-${signalColor(s.signal_type)}`}>{s.signal_type}</span>
                      </td>
                      <td>{parseFloat(s.price).toFixed(5)}</td>
                      <td className="muted">{format(new Date(s.created_at), 'HH:mm dd/MM')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
