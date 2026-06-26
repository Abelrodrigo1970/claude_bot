import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';

const signalColor = (type) => {
  if (!type) return 'hold';
  if (type.includes('long')) return 'long';
  if (type.includes('short')) return 'short';
  if (type.includes('flip')) return 'flip';
  return 'hold';
};

// Agrupa sinais por símbolo numa janela de 2h e retorna os com confluência (2+ estratégias)
function getConfluenceSignals(signals) {
  const windowMs = 2 * 60 * 60 * 1000;
  const groups = {};
  signals.forEach(s => {
    const t = new Date(s.created_at).getTime();
    const dir = s.signal_type.includes('long') ? 'long' : 'short';
    const key = `${s.symbol}_${dir}`;
    if (!groups[key]) groups[key] = [];
    // Agrupa apenas se dentro da janela de 2h do primeiro sinal do grupo
    const first = groups[key][0];
    if (!first || Math.abs(t - new Date(first.created_at).getTime()) <= windowMs) {
      if (!groups[key].find(g => g.strategy_name === s.strategy_name)) {
        groups[key].push(s);
      }
    }
  });
  return Object.values(groups)
    .filter(g => g.length >= 2)
    .flat()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export default function Signals() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('all');

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await axios.get('/api/signals?limit=200');
        setSignals(data);
      } finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const displayed = view === 'confluence' ? getConfluenceSignals(signals) : signals;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Sinais</div>
          <div className="page-sub">Atualiza a cada 15s · {signals.length} sinais registados</div>
        </div>
        <div className="scanner-tabs">
          <button className={`scanner-tab ${view === 'all' ? 'active' : ''}`} onClick={() => setView('all')}>
            Todos
          </button>
          <button className={`scanner-tab ${view === 'confluence' ? 'active' : ''}`} onClick={() => setView('confluence')}>
            Confluência 2+
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : displayed.length === 0 ? (
          <div className="empty">{view === 'confluence' ? 'Nenhuma confluência encontrada ainda.' : 'Nenhum sinal ainda. O bot ainda não executou.'}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sinal</th>
                  <th>Estratégia</th>
                  <th>Par</th>
                  <th>Preço</th>
                  <th>TF</th>
                  <th>EMA12</th>
                  <th>EMA30</th>
                  <th>RSI</th>
                  <th>Vol/Avg</th>
                  <th>Data</th>
                  <th>Chart</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(s => {
                  const ind = s.indicators || {};
                  const volRatio = ind.volRatio != null ? parseFloat(ind.volRatio).toFixed(1)
                    : (ind.volume && ind.avgVolume ? (ind.volume / ind.avgVolume).toFixed(1) : '—');
                  const base = s.symbol?.split('/')[0];
                  const tvUrl = `https://www.tradingview.com/chart/?symbol=BYBIT:${base}USDT.P`;
                  return (
                    <tr key={s.id}>
                      <td>
                        <span className={`signal-dot ${signalColor(s.signal_type)}`} />
                        <span className={`badge badge-${signalColor(s.signal_type)}`}>{s.signal_type}</span>
                      </td>
                      <td className="muted">{s.strategy_name}</td>
                      <td style={{ color: '#e2e8f0' }}>{base}</td>
                      <td>{parseFloat(s.price).toFixed(6)}</td>
                      <td className="muted">{s.timeframe}</td>
                      <td className="muted">{ind.ema12 ? parseFloat(ind.ema12).toFixed(5) : '—'}</td>
                      <td className="muted">{ind.ema30 ? parseFloat(ind.ema30).toFixed(5) : '—'}</td>
                      <td className={ind.rsi > 70 ? 'red' : ind.rsi < 30 ? 'green' : 'muted'}>
                        {ind.rsi ? parseFloat(ind.rsi).toFixed(1) : '—'}
                      </td>
                      <td className={parseFloat(volRatio) > 1.3 ? 'yellow' : 'muted'}>{volRatio}x</td>
                      <td className="muted">{format(new Date(s.created_at), 'dd/MM HH:mm:ss')}</td>
                      <td>
                        <a href={tvUrl} target="_blank" rel="noopener noreferrer" className="tv-link" title="Ver no TradingView">
                          📈
                        </a>
                      </td>
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
