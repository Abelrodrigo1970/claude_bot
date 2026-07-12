import React, { useEffect, useRef, useState, useCallback } from 'react';
import axios from 'axios';
import { format } from 'date-fns';

function fmt(n, dec = 2) { return n == null ? '—' : parseFloat(n).toFixed(dec); }
function fmtVol(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return fmt(v);
}

function TrendBar({ pct }) {
  const capped = Math.min(pct, 50);
  const width  = (capped / 50) * 100;
  const color  = pct > 30 ? '#f5c842' : pct > 10 ? '#00d4a0' : '#4f8ef7';
  return (
    <div className="trend-bar-wrap">
      <div className="trend-bar-fill" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}

function ResultsTable({ results, period }) {
  const [sortBy, setSortBy] = useState('pctAbove');
  const sorted = [...(results || [])].sort((a, b) => {
    if (sortBy === 'pctAbove')  return b.pctAbove - a.pctAbove;
    if (sortBy === 'change24h') return b.change24h - a.change24h;
    if (sortBy === 'volume')    return b.volume - a.volume;
    return 0;
  });
  const SortBtn = ({ field, label }) => (
    <button className={`sort-btn ${sortBy === field ? 'active' : ''}`} onClick={() => setSortBy(field)}>{label}</button>
  );
  return (
    <>
      <div className="scanner-toolbar">
        <span className="muted" style={{ fontSize: 12 }}>{results.length} pares acima da EMA{period}</span>
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
                <th>EMA{period}</th>
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
                  <td className="mono muted">{fmt(r.ema, 4)}</td>
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
  );
}

function HistoryPanel({ period }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [openIdx, setOpenIdx]   = useState(0);

  useEffect(() => {
    axios.get(`/api/scanner/history?period=${period}&sessions=10`)
      .then(r => setSessions(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period]);

  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!sessions.length) return (
    <div className="card"><div className="empty">Nenhum histórico ainda. Corre o scanner para começar a guardar.</div></div>
  );

  return (
    <div>
      {sessions.map((session, idx) => (
        <div key={session.scanned_at} className="card" style={{ marginBottom: 12 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
            onClick={() => setOpenIdx(openIdx === idx ? -1 : idx)}
          >
            <div>
              <span style={{ fontWeight: 600, color: '#e2e8f0' }}>
                {format(new Date(session.scanned_at), 'dd/MM/yyyy HH:mm')}
              </span>
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                {session.results.length} pares acima da EMA{period}
              </span>
            </div>
            <span className="muted">{openIdx === idx ? '▲' : '▼'}</span>
          </div>
          {openIdx === idx && (
            <div style={{ marginTop: 16 }}>
              <ResultsTable results={session.results} period={period} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ScannerPanel({ period }) {
  const [view, setView]   = useState('scan');
  const [state, setState] = useState({ status: 'idle', progress: 0, total: 0, results: [], scannedAt: null });
  const pollRef = useRef(null);

  const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };

  const fetchState = useCallback(async () => {
    try {
      const { data } = await axios.get(`/api/scanner?period=${period}`);
      setState(data);
      if (data.status !== 'scanning') stopPolling();
    } catch { stopPolling(); }
  }, [period]); // eslint-disable-line

  const startScan = async () => {
    await axios.post(`/api/scanner/start?period=${period}`);
    setState(s => ({ ...s, status: 'scanning', progress: 0, results: [] }));
    setView('scan');
    stopPolling();
    pollRef.current = setInterval(fetchState, 2000);
  };

  useEffect(() => {
    fetchState();
    return () => stopPolling();
  }, [fetchState]);

  const pct = state.total > 0 ? Math.round((state.progress / state.total) * 100) : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-sub">
            Pares acima da EMA{period} diária · Top 250 por volume
            {state.scannedAt && (
              <span className="scan-time"> · Scan: {new Date(state.scannedAt).toLocaleTimeString('pt-PT')}</span>
            )}
          </div>
          <div className="scanner-tabs" style={{ marginTop: 10 }}>
            <button className={`scanner-tab ${view === 'scan' ? 'active' : ''}`} onClick={() => setView('scan')}>
              Atual
            </button>
            <button className={`scanner-tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
              Histórico
            </button>
          </div>
        </div>
        <button className="btn btn-primary" onClick={startScan} disabled={state.status === 'scanning'}>
          {state.status === 'scanning' ? '⏳ A escanear...' : state.status === 'done' ? '🔄 Atualizar' : '🔍 Iniciar Scanner'}
        </button>
      </div>

      {view === 'history' ? (
        <HistoryPanel key={period} period={period} />
      ) : (
        <>
          {state.status === 'scanning' && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="muted">A analisar pares...</span>
                <span className="mono muted">{state.progress}/{state.total} ({pct}%)</span>
              </div>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
            </div>
          )}

          {state.status === 'idle' && (
            <div className="card">
              <div className="empty">
                Clica em <strong>Iniciar Scanner</strong> para varrer os top 250 pares por volume e encontrar os que estão acima da EMA{period} diária.
              </div>
            </div>
          )}

          {state.results?.length > 0 && (
            <ResultsTable results={state.results} period={period} />
          )}

          {state.status === 'error' && (
            <div className="card"><div className="empty red">Erro: {state.error}</div></div>
          )}
        </>
      )}
    </div>
  );
}

function GainersResultsTable({ results }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Par</th>
              <th>Preço</th>
              <th>Var 24h</th>
              <th>Volume 24h</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
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
                <td className={`mono ${r.change24h >= 0 ? 'green' : 'red'}`}>
                  {r.change24h >= 0 ? '+' : ''}{fmt(r.change24h)}%
                </td>
                <td className="mono muted">{fmtVol(r.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GainersHistoryPanel() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [openIdx, setOpenIdx]   = useState(0);

  useEffect(() => {
    axios.get(`/api/scanner/gainers/history?sessions=10`)
      .then(r => setSessions(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!sessions.length) return (
    <div className="card"><div className="empty">Nenhum histórico ainda. Corre o scanner para começar a guardar.</div></div>
  );

  return (
    <div>
      {sessions.map((session, idx) => (
        <div key={session.scanned_at} className="card" style={{ marginBottom: 12 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
            onClick={() => setOpenIdx(openIdx === idx ? -1 : idx)}
          >
            <div>
              <span style={{ fontWeight: 600, color: '#e2e8f0' }}>
                {format(new Date(session.scanned_at), 'dd/MM/yyyy HH:mm')}
              </span>
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                {session.results.length} pares
              </span>
            </div>
            <span className="muted">{openIdx === idx ? '▲' : '▼'}</span>
          </div>
          {openIdx === idx && (
            <div style={{ marginTop: 16 }}>
              <GainersResultsTable results={session.results} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GainersPanel() {
  const [view, setView]   = useState('scan');
  const [state, setState] = useState({ status: 'idle', progress: 0, total: 0, results: [], scannedAt: null });
  const pollRef = useRef(null);

  const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };

  const fetchState = useCallback(async () => {
    try {
      const { data } = await axios.get(`/api/scanner/gainers`);
      setState(data);
      if (data.status !== 'scanning') stopPolling();
    } catch { stopPolling(); }
  }, []);

  const startScan = async () => {
    await axios.post(`/api/scanner/gainers/start?limit=6`);
    setState(s => ({ ...s, status: 'scanning', progress: 0, results: [] }));
    setView('scan');
    stopPolling();
    pollRef.current = setInterval(fetchState, 2000);
  };

  useEffect(() => {
    fetchState();
    return () => stopPolling();
  }, [fetchState]);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-sub">
            Top 6 maiores subidas nas últimas 24h · Top 250 por volume · atualiza a cada 2h
            {state.scannedAt && (
              <span className="scan-time"> · Scan: {new Date(state.scannedAt).toLocaleTimeString('pt-PT')}</span>
            )}
          </div>
          <div className="scanner-tabs" style={{ marginTop: 10 }}>
            <button className={`scanner-tab ${view === 'scan' ? 'active' : ''}`} onClick={() => setView('scan')}>
              Atual
            </button>
            <button className={`scanner-tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
              Histórico
            </button>
          </div>
        </div>
        <button className="btn btn-primary" onClick={startScan} disabled={state.status === 'scanning'}>
          {state.status === 'scanning' ? '⏳ A escanear...' : state.status === 'done' ? '🔄 Atualizar' : '🔍 Iniciar Scanner'}
        </button>
      </div>

      {view === 'history' ? (
        <GainersHistoryPanel />
      ) : (
        <>
          {state.status === 'idle' && (
            <div className="card">
              <div className="empty">
                Clica em <strong>Iniciar Scanner</strong> para ver as 6 moedas que mais subiram nas últimas 24h.
              </div>
            </div>
          )}

          {state.results?.length > 0 && (
            <GainersResultsTable results={state.results} />
          )}

          {state.status === 'error' && (
            <div className="card"><div className="empty red">Erro: {state.error}</div></div>
          )}
        </>
      )}
    </div>
  );
}

function EmaTrendResultsTable({ results }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Par</th>
              <th>Preço</th>
              <th>EMA21 (1d)</th>
              <th>EMA50 (1d)</th>
              <th>EMA21 (1h)</th>
              <th>EMA50 (1h)</th>
              <th>Força média</th>
              <th>Var 24h</th>
              <th>Volume 24h</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
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
                <td className="mono muted">{fmt(r.ema21_1d, 4)}</td>
                <td className="mono muted">{fmt(r.ema50_1d, 4)}</td>
                <td className="mono muted">{fmt(r.ema21_1h, 4)}</td>
                <td className="mono muted">{fmt(r.ema50_1h, 4)}</td>
                <td className="mono green">+{fmt(r.pctAbove ?? r.pct_above)}%</td>
                <td className={`mono ${(r.change24h ?? r.change_24h) >= 0 ? 'green' : 'red'}`}>
                  {(r.change24h ?? r.change_24h) == null ? '—' : `${(r.change24h ?? r.change_24h) >= 0 ? '+' : ''}${fmt(r.change24h ?? r.change_24h)}%`}
                </td>
                <td className="mono muted">{fmtVol(r.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmaTrendHistoryPanel() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [openIdx, setOpenIdx]   = useState(0);

  useEffect(() => {
    axios.get(`/api/scanner/ematrend/history?sessions=10`)
      .then(r => setSessions(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><div className="spinner" /></div>;
  if (!sessions.length) return (
    <div className="card"><div className="empty">Nenhum histórico ainda. Corre o scanner para começar a guardar.</div></div>
  );

  return (
    <div>
      {sessions.map((session, idx) => (
        <div key={session.scanned_at} className="card" style={{ marginBottom: 12 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
            onClick={() => setOpenIdx(openIdx === idx ? -1 : idx)}
          >
            <div>
              <span style={{ fontWeight: 600, color: '#e2e8f0' }}>
                {format(new Date(session.scanned_at), 'dd/MM/yyyy HH:mm')}
              </span>
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                {session.results.length} pares
              </span>
            </div>
            <span className="muted">{openIdx === idx ? '▲' : '▼'}</span>
          </div>
          {openIdx === idx && (
            <div style={{ marginTop: 16 }}>
              <EmaTrendResultsTable results={session.results} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function EmaTrendPanel() {
  const [view, setView]   = useState('scan');
  const [state, setState] = useState({ status: 'idle', progress: 0, total: 0, results: [], scannedAt: null });
  const pollRef = useRef(null);

  const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };

  const fetchState = useCallback(async () => {
    try {
      const { data } = await axios.get(`/api/scanner/ematrend`);
      setState(data);
      if (data.status !== 'scanning') stopPolling();
    } catch { stopPolling(); }
  }, []);

  const startScan = async () => {
    await axios.post(`/api/scanner/ematrend/start?limit=50`);
    setState(s => ({ ...s, status: 'scanning', progress: 0, results: [] }));
    setView('scan');
    stopPolling();
    pollRef.current = setInterval(fetchState, 2000);
  };

  useEffect(() => {
    fetchState();
    return () => stopPolling();
  }, [fetchState]);

  const pct = state.total > 0 ? Math.round((state.progress / state.total) * 100) : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-sub">
            Preço acima da EMA21 e EMA50, no diário E no 1h · Top 250 por volume
            {state.scannedAt && (
              <span className="scan-time"> · Scan: {new Date(state.scannedAt).toLocaleTimeString('pt-PT')}</span>
            )}
          </div>
          <div className="scanner-tabs" style={{ marginTop: 10 }}>
            <button className={`scanner-tab ${view === 'scan' ? 'active' : ''}`} onClick={() => setView('scan')}>
              Atual
            </button>
            <button className={`scanner-tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
              Histórico
            </button>
          </div>
        </div>
        <button className="btn btn-primary" onClick={startScan} disabled={state.status === 'scanning'}>
          {state.status === 'scanning' ? '⏳ A escanear...' : state.status === 'done' ? '🔄 Atualizar' : '🔍 Iniciar Scanner'}
        </button>
      </div>

      {view === 'history' ? (
        <EmaTrendHistoryPanel />
      ) : (
        <>
          {state.status === 'scanning' && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="muted">A analisar pares (diário + 1h)...</span>
                <span className="mono muted">{state.progress}/{state.total} ({pct}%)</span>
              </div>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
            </div>
          )}

          {state.status === 'idle' && (
            <div className="card">
              <div className="empty">
                Clica em <strong>Iniciar Scanner</strong> para encontrar pares com preço acima da EMA21 e EMA50,
                simultaneamente no diário e no 1h.
              </div>
            </div>
          )}

          {state.results?.length > 0 && (
            <EmaTrendResultsTable results={state.results} />
          )}

          {state.status === 'error' && (
            <div className="card"><div className="empty red">Erro: {state.error}</div></div>
          )}
        </>
      )}
    </div>
  );
}

export default function Scanner() {
  const [tab, setTab] = useState(200);

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div className="page-title">Scanner TOP 50</div>
      </div>

      <div className="scanner-tabs">
        {[200, 90].map(p => (
          <button
            key={p}
            className={`scanner-tab ${tab === p ? 'active' : ''}`}
            onClick={() => setTab(p)}
          >
            EMA {p}
          </button>
        ))}
        <button
          className={`scanner-tab ${tab === 'gainers24h' ? 'active' : ''}`}
          onClick={() => setTab('gainers24h')}
        >
          Top 6 (24h)
        </button>
        <button
          className={`scanner-tab ${tab === 'ematrend' ? 'active' : ''}`}
          onClick={() => setTab('ematrend')}
        >
          EMA Trend (21/50)
        </button>
      </div>

      {tab === 'gainers24h' ? <GainersPanel key="gainers24h" />
        : tab === 'ematrend' ? <EmaTrendPanel key="ematrend" />
        : <ScannerPanel key={tab} period={tab} />}
    </div>
  );
}
