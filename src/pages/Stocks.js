import React, { useEffect, useState, useCallback, useMemo } from 'react';
import axios from 'axios';

const CATEGORY_LABELS = { stock: 'Stock', etf: 'ETF', index: 'Índice', metal: 'Metal', commodity: 'Commodity' };

function Pct({ v }) {
  if (v == null) return <span className="muted">—</span>;
  const n = parseFloat(v);
  const cls = n > 0 ? 'green' : n < 0 ? 'red' : 'muted';
  return <span className={cls}>{n > 0 ? '+' : ''}{n.toFixed(2)}%</span>;
}

function fmt(v) {
  if (v == null) return '—';
  const n = parseFloat(v);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10)   return n.toFixed(3);
  if (n >= 1)    return n.toFixed(4);
  return n.toFixed(5);
}

function fmtVol(v) {
  if (!v) return '—';
  const n = parseFloat(v);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

const COLUMNS = [
  { key: 'ticker',    label: 'Ticker',      sortVal: s => s.ticker },
  { key: 'category',  label: 'Categoria',   sortVal: s => s.category },
  { key: 'price',     label: 'Preço',       sortVal: s => s.price ?? -Infinity },
  { key: 'change24h', label: '24h %',       sortVal: s => s.change24h ?? -Infinity },
  { key: 'monthly',   label: '30d %',       sortVal: s => s.monthly ?? -Infinity },
  { key: 'high24h',   label: '24h High',    sortVal: s => s.high24h ?? -Infinity },
  { key: 'low24h',    label: '24h Low',     sortVal: s => s.low24h ?? -Infinity },
  { key: 'volume24h', label: 'Volume 24h',  sortVal: s => s.volume24h ?? -Infinity },
];

export default function Stocks() {
  const [stocks,       setStocks]       = useState([]);
  const [prices,       setPrices]       = useState({});
  const [monthly,      setMonthly]      = useState({});
  const [loading,      setLoading]      = useState(true);
  const [priceLoading, setPriceLoading] = useState(false);
  const [monthLoading, setMonthLoading] = useState(false);
  const [filter,       setFilter]       = useState('all');
  const [search,       setSearch]       = useState('');
  const [lastUpdate,   setLastUpdate]   = useState(null);
  const [sortField,    setSortField]    = useState('ticker');
  const [sortDir,      setSortDir]      = useState('asc');

  useEffect(() => {
    axios.get('/api/stocks')
      .then(r => { setStocks(r.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const fetchPrices = useCallback(async () => {
    setPriceLoading(true);
    try {
      const { data } = await axios.get('/api/stocks/prices');
      setPrices(data);
      setLastUpdate(new Date());
    } catch {}
    finally { setPriceLoading(false); }
  }, []);

  const fetchMonthly = useCallback(async () => {
    setMonthLoading(true);
    try {
      const { data } = await axios.get('/api/stocks/monthly');
      setMonthly(data);
    } catch {}
    finally { setMonthLoading(false); }
  }, []);

  useEffect(() => {
    fetchPrices();
    fetchMonthly();
    const id = setInterval(fetchPrices, 30000);
    return () => clearInterval(id);
  }, [fetchPrices, fetchMonthly]);

  function handleSort(key) {
    if (sortField === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(key); setSortDir('asc'); }
  }

  function SortIcon({ col }) {
    if (sortField !== col) return <span style={{ opacity: 0.25, marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4, color: 'var(--blue)' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const categories = useMemo(
    () => ['all', ...new Set(stocks.map(s => s.category))].sort(),
    [stocks]
  );

  // Merge stocks + prices + monthly into flat rows
  const rows = useMemo(() => stocks.map(s => {
    const p = prices[s.ticker] || {};
    return {
      ...s,
      price:     p.price     ?? null,
      change24h: p.change24h ?? null,
      high24h:   p.high24h   ?? null,
      low24h:    p.low24h    ?? null,
      volume24h: p.volume24h ?? null,
      monthly:   monthly[s.ticker] ?? null,
    };
  }), [stocks, prices, monthly]);

  const displayed = useMemo(() => {
    const col = COLUMNS.find(c => c.key === sortField);
    return rows
      .filter(s => {
        if (filter !== 'all' && s.category !== filter) return false;
        if (search && !s.ticker.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        const va = col ? col.sortVal(a) : a.ticker;
        const vb = col ? col.sortVal(b) : b.ticker;
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
  }, [rows, filter, search, sortField, sortDir]);

  const tvUrl = ticker => `https://www.tradingview.com/chart/?symbol=BYBIT:${ticker}USDT.P`;

  const thStyle = { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Stocks & ETFs</div>
          <div className="page-sub">
            {stocks.length} ativos · {lastUpdate ? `preços ${lastUpdate.toLocaleTimeString('pt-PT')}` : 'a carregar...'}
            {(priceLoading || monthLoading) && <span className="muted"> · a atualizar...</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-outline" onClick={fetchMonthly} disabled={monthLoading} title="Recalcular 30d %">
            {monthLoading ? '⟳' : '↻'} 30d
          </button>
          <button className="btn-outline" onClick={fetchPrices} disabled={priceLoading} title="Atualizar preços">
            {priceLoading ? '⟳' : '↻'} Preços
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="scanner-tabs" style={{ margin: 0 }}>
          {categories.map(c => (
            <button
              key={c}
              className={`scanner-tab ${filter === c ? 'active' : ''}`}
              onClick={() => setFilter(c)}
            >
              {c === 'all' ? 'Todos' : CATEGORY_LABELS[c] || c}
              {c !== 'all' && (
                <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>
                  ({stocks.filter(s => s.category === c).length})
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Pesquisar ticker..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            background: 'var(--bg3)', border: '1px solid var(--border)',
            color: 'var(--text)', padding: '6px 12px', borderRadius: 6,
            fontSize: 13, outline: 'none', width: 160,
          }}
        />
        <span className="muted" style={{ fontSize: 12 }}>{displayed.length} resultados</span>
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map(col => (
                    <th key={col.key} style={thStyle} onClick={() => handleSort(col.key)}>
                      {col.label}<SortIcon col={col.key} />
                    </th>
                  ))}
                  <th>Chart</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(s => (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--text)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                      {s.ticker}
                    </td>
                    <td>
                      <span className="badge badge-hold" style={{ fontSize: 11 }}>
                        {CATEGORY_LABELS[s.category] || s.category}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      {s.price != null ? fmt(s.price) : <span className="muted">—</span>}
                    </td>
                    <td><Pct v={s.change24h} /></td>
                    <td><Pct v={s.monthly} /></td>
                    <td className="muted">{s.high24h != null ? fmt(s.high24h) : '—'}</td>
                    <td className="muted">{s.low24h  != null ? fmt(s.low24h)  : '—'}</td>
                    <td className="muted">{fmtVol(s.volume24h)}</td>
                    <td>
                      <a
                        href={tvUrl(s.ticker)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tv-link"
                        title={`Ver ${s.ticker} no TradingView`}
                      >
                        📈
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
