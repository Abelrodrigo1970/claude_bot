import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';

export default function Trades() {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const status = filter === 'all' ? '' : filter;
        const { data } = await axios.get(`/api/trades?limit=100${status ? `&status=${status}` : ''}`);
        setTrades(data);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [filter]);

  const totalPnl = trades.filter(t => t.status === 'closed').reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
  const wins = trades.filter(t => t.status === 'closed' && parseFloat(t.pnl) > 0).length;
  const closed = trades.filter(t => t.status === 'closed').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Histórico de Trades</div>
          <div className="page-sub">
            {closed > 0 && `${wins}/${closed} vencedores · PnL: `}
            <span className={totalPnl >= 0 ? 'green' : 'red'}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(4)} USDT
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['all', 'open', 'closed'].map(f => (
            <button key={f} className={`btn ${filter === f ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Todos' : f === 'open' ? 'Abertos' : 'Fechados'}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
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
                {trades.map(t => {
                  const pnl = parseFloat(t.pnl || 0);
                  const pnlPct = parseFloat(t.pnl_pct || 0);
                  return (
                    <tr key={t.id}>
                      <td className="muted">{t.id}</td>
                      <td>{t.strategy_name}</td>
                      <td style={{ color: '#e2e8f0' }}>{t.symbol.split('/')[0]}/USDT</td>
                      <td><span className={`badge badge-${t.side}`}>{t.side.toUpperCase()}</span></td>
                      <td>{parseFloat(t.entry_price).toFixed(6)}</td>
                      <td>{t.exit_price ? parseFloat(t.exit_price).toFixed(6) : <span className="muted">—</span>}</td>
                      <td className="muted">{parseFloat(t.quantity).toFixed(2)}</td>
                      <td className={pnl >= 0 ? 'green' : 'red'}>
                        {t.status === 'closed' ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}` : <span className="muted">—</span>}
                      </td>
                      <td className={pnlPct >= 0 ? 'green' : 'red'}>
                        {t.status === 'closed' ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : <span className="muted">—</span>}
                      </td>
                      <td><span className={`badge badge-${t.status}`}>{t.status}</span></td>
                      <td className="muted">{format(new Date(t.opened_at), 'dd/MM HH:mm')}</td>
                      <td className="muted">{t.closed_at ? format(new Date(t.closed_at), 'dd/MM HH:mm') : '—'}</td>
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
