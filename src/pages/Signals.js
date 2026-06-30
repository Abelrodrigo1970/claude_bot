import React, { useEffect, useState, useMemo } from 'react';
import axios from 'axios';
import { format, isAfter, isBefore, startOfDay, endOfDay, subDays } from 'date-fns';

const signalColor = (type) => {
  if (!type) return 'hold';
  if (type.includes('long'))  return 'long';
  if (type.includes('short')) return 'short';
  if (type.includes('flip'))  return 'flip';
  return 'hold';
};

function getConfluenceSignals(signals) {
  const windowMs = 2 * 60 * 60 * 1000;
  const groups = {};
  signals.forEach(s => {
    const t   = new Date(s.created_at).getTime();
    const dir = s.signal_type.includes('long') ? 'long' : 'short';
    const key = `${s.symbol}_${dir}`;
    if (!groups[key]) groups[key] = [];
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

const DATE_PRESETS = [
  { label: 'Hoje',       days: 0 },
  { label: '7 dias',     days: 7 },
  { label: '30 dias',    days: 30 },
  { label: 'Tudo',       days: null },
];

export default function Signals() {
  const [signals,    setSignals]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [view,       setView]       = useState('all');

  // Filtros
  const [fStrategy,  setFStrategy]  = useState('');
  const [fSignal,    setFSignal]    = useState('');
  const [fPair,      setFPair]      = useState('');
  const [fDateFrom,  setFDateFrom]  = useState('');
  const [fDateTo,    setFDateTo]    = useState('');
  const [datePreset, setDatePreset] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await axios.get('/api/signals?limit=500');
        setSignals(data);
      } finally { setLoading(false); }
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  // Opções únicas para os dropdowns
  const strategies  = useMemo(() => [...new Set(signals.map(s => s.strategy_name))].sort(), [signals]);
  const signalTypes = useMemo(() => [...new Set(signals.map(s => s.signal_type))].sort(), [signals]);
  const pairs       = useMemo(() => [...new Set(signals.map(s => s.symbol?.split('/')[0]))].filter(Boolean).sort(), [signals]);

  function applyPreset(days) {
    setDatePreset(days);
    if (days === null) { setFDateFrom(''); setFDateTo(''); return; }
    const now  = new Date();
    const from = days === 0 ? startOfDay(now) : subDays(now, days);
    setFDateFrom(format(from, 'yyyy-MM-dd'));
    setFDateTo(format(now, 'yyyy-MM-dd'));
  }

  const filtered = useMemo(() => {
    let list = view === 'confluence' ? getConfluenceSignals(signals) : signals;

    if (fStrategy)  list = list.filter(s => s.strategy_name === fStrategy);
    if (fSignal)    list = list.filter(s => s.signal_type   === fSignal);
    if (fPair)      list = list.filter(s => s.symbol?.split('/')[0] === fPair);
    if (fDateFrom)  list = list.filter(s => !isBefore(new Date(s.created_at), startOfDay(new Date(fDateFrom))));
    if (fDateTo)    list = list.filter(s => !isAfter(new Date(s.created_at),  endOfDay(new Date(fDateTo))));

    return list;
  }, [signals, view, fStrategy, fSignal, fPair, fDateFrom, fDateTo]);

  const hasFilters = fStrategy || fSignal || fPair || fDateFrom || fDateTo;

  function clearFilters() {
    setFStrategy(''); setFSignal(''); setFPair('');
    setFDateFrom(''); setFDateTo(''); setDatePreset(null);
  }

  const selectStyle = {
    background: 'var(--bg3)', border: '1px solid var(--border)',
    color: 'var(--text)', padding: '6px 10px', borderRadius: 6,
    fontSize: 12, outline: 'none', cursor: 'pointer',
  };
  const inputStyle = {
    ...selectStyle, width: 130,
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Sinais</div>
          <div className="page-sub">
            Atualiza a cada 15s · {signals.length} sinais · {filtered.length} visíveis
          </div>
        </div>
        <div className="scanner-tabs">
          <button className={`scanner-tab ${view === 'all'         ? 'active' : ''}`} onClick={() => setView('all')}>Todos</button>
          <button className={`scanner-tab ${view === 'confluence'  ? 'active' : ''}`} onClick={() => setView('confluence')}>Confluência 2+</button>
        </div>
      </div>

      {/* ── Filtros ─────────────────────────────────────────────── */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>

          {/* Estratégia */}
          <select style={selectStyle} value={fStrategy} onChange={e => setFStrategy(e.target.value)}>
            <option value="">Estratégia</option>
            {strategies.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Tipo de sinal */}
          <select style={selectStyle} value={fSignal} onChange={e => setFSignal(e.target.value)}>
            <option value="">Tipo de sinal</option>
            {signalTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>

          {/* Par */}
          <select style={selectStyle} value={fPair} onChange={e => setFPair(e.target.value)}>
            <option value="">Par</option>
            {pairs.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <div style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 4px' }} />

          {/* Presets de data */}
          {DATE_PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.days)}
              style={{
                ...selectStyle, padding: '6px 10px',
                background: datePreset === p.days ? 'var(--blue)' : 'var(--bg3)',
                color: datePreset === p.days ? '#fff' : 'var(--muted)',
                border: `1px solid ${datePreset === p.days ? 'var(--blue)' : 'var(--border)'}`,
              }}
            >
              {p.label}
            </button>
          ))}

          {/* Datas manuais */}
          <input
            type="date"
            style={inputStyle}
            value={fDateFrom}
            onChange={e => { setFDateFrom(e.target.value); setDatePreset(null); }}
            title="Data de início"
          />
          <span className="muted" style={{ fontSize: 12 }}>→</span>
          <input
            type="date"
            style={inputStyle}
            value={fDateTo}
            onChange={e => { setFDateTo(e.target.value); setDatePreset(null); }}
            title="Data de fim"
          />

          {hasFilters && (
            <button onClick={clearFilters} style={{ ...selectStyle, color: 'var(--red)', borderColor: 'var(--red)' }}>
              ✕ Limpar
            </button>
          )}
        </div>
      </div>

      {/* ── Tabela ──────────────────────────────────────────────── */}
      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            {hasFilters ? 'Nenhum sinal corresponde aos filtros.' : 'Nenhum sinal ainda.'}
          </div>
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
                {filtered.map(s => {
                  const ind      = s.indicators || {};
                  const volRatio = ind.volRatio != null
                    ? parseFloat(ind.volRatio).toFixed(1)
                    : (ind.volume && ind.avgVolume ? (ind.volume / ind.avgVolume).toFixed(1) : '—');
                  const base  = s.symbol?.split('/')[0];
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
                      <td className="muted">{format(new Date(s.created_at), 'dd/MM HH:mm')}</td>
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
