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

export default function Signals() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await axios.get('/api/signals?limit=100');
        setSignals(data);
      } finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Sinais</div>
          <div className="page-sub">Atualiza a cada 15s · {signals.length} sinais registados</div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : signals.length === 0 ? (
          <div className="empty">Nenhum sinal ainda. O bot ainda não executou.</div>
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
                {signals.map(s => {
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
