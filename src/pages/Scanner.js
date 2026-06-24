import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';

function fmt(n, dec = 2) { return n == null ? '—' : parseFloat(n).toFixed(dec); }
function fmtVol(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return fmt(v);
}

export default function Scanner() {
  const [state, setState] = useState({ status: 'idle', progress: 0, total: 0, results: [], scannedAt: null });
  const [sortBy, setSortBy] = useState('pctAbove');
  const pollRef = useRef(null);

  const fetchState = async () => {
    try {
      const { data } = await axios.get('/api/scanner');
      setState(data);
      if (data.status !== 'scanning') stopPolling();
    } catch { stopPolling(); }
  };

  const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };

  const startScan = async () => {
    await axios.post('/api/scanner/start');
    setState(s => ({ ...s, status: 'scanning', progress: 0, results: [] }));
    stopPolling();
    pollRef.current = setInterval(fetchState, 2000);
  };

  useEffect(() => {
    fetchState();
    return () => stopPolling();
  }, []); // eslint-disable-line

  const sorted = [...(state.results || [])].sort((a, b) => {
    if (sortBy === 'pctAbove') return b.pctAbove - a.pctAbove;
    if (sortBy === 'change24h') return b.change24h - a.change24h;
    if (sortBy === 'volume')   return b.volume - a.volume;
    return 0;
  });

  const pct = state.total > 0 ? Math.round((state.progress / state.total) * 100) : 0;

  const SortBtn = ({ field, label }) => (
    <button
      className={`sort-btn ${sortBy === field ? 'active' : ''}`}
      onClick={() => setSortBy(field)}
    >{label}</button>
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Scanner TOP 50</div>
          <div className="page-sub">
            Criptos acima da EMA200 diária
            {state.scannedAt && (
              <span className="scan-time"> · Scan: {new Date(state.scannedAt).toLocaleTimeString('pt-PT')}</span>
            )}
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={startScan}
          disabled={state.status === 'scanning'}
        >
          {state.status === 'scanning' ? '⏳ A escanear...' : state.status === 'done' ? '🔄 Atualizar' : '🔍 Iniciar Scanner'}
        </button>
      </div>

      {/* PROGRESSO */}
      {state.status === 'scanning' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="muted">A analisar pares...</span>
            <span className="mono muted">{state.progress}/{state.total} ({pct}%)</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* IDLE */}
      {state.status === 'idle' && (
        <div className="card">
          <div className="empty">
            Clica em <strong>Iniciar Scanner</strong> para varrer os top 150 pares por volume e encontrar os que estão acima da EMA200 diária.
          </div>
        </div>
      )}

      {/* RESULTADOS */}
      {state.results?.length > 0 && (
        <>
          <div className="scanner-toolbar">
            <span className="muted" style={{ fontSize: 12 }}>{state.results.length} pares acima da EMA200</span>
            <div className="sort-group">
              <span className="muted" style={{ fontSize: 11 }}>Ordenar:</span>
              <SortBtn field="pctAbove"  label="% Acima EMA" />
              <SortBtn field="change24h" label="Var 24h" />
              <SortBtn field="volume"    label="Volume" />
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Par</th>
                    <th>Preço</th>
                    <th>EMA200</th>
                    <th>% Acima EMA</th>
                    <th>Var 24h</th>
                    <th>Volume 24h</th>
                    <th>Força</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={r.symbol}>
                      <td className="muted">{i + 1}</td>
                      <td>
                        <a
                          className="symbol-link"
                          href={`https://www.tradingview.com/chart/?symbol=BYBIT:${r.symbol.split('/')[0]}USDT.P`}
                          target="_blank"
                          rel="noreferrer"
                          title="Ver no TradingView"
                        >
                          <span className="symbol-name">{r.symbol.split('/')[0]}</span>
                          <span className="symbol-suffix">/USDT</span>
                          <span className="tv-icon">↗</span>
                        </a>
                      </td>
                      <td className="mono">{fmt(r.price, 4)}</td>
                      <td className="mono muted">{fmt(r.ema200, 4)}</td>
                      <td className="mono green">+{fmt(r.pctAbove)}%</td>
                      <td className={`mono ${r.change24h >= 0 ? 'green' : 'red'}`}>
                        {r.change24h >= 0 ? '+' : ''}{fmt(r.change24h)}%
                      </td>
                      <td className="mono muted">{fmtVol(r.volume)}</td>
                      <td><TrendBar pct={r.pctAbove} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {state.status === 'error' && (
        <div className="card">
          <div className="empty red">Erro: {state.error}</div>
        </div>
      )}
    </div>
  );
}

function TrendBar({ pct }) {
  const capped = Math.min(pct, 50); // cap visual em 50%
  const width  = (capped / 50) * 100;
  const color  = pct > 30 ? '#f5c842' : pct > 10 ? '#00d4a0' : '#4f8ef7';
  return (
    <div className="trend-bar-wrap">
      <div className="trend-bar-fill" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}
