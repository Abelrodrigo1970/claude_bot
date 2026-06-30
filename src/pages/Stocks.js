import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';

const CATEGORY_LABELS = { stock: 'Stock', etf: 'ETF', index: 'Índice', metal: 'Metal', commodity: 'Commodity' };

function pct(v) {
  if (v == null) return <span className="muted">—</span>;
  const n = parseFloat(v);
  const cls = n > 0 ? 'green' : n < 0 ? 'red' : 'muted';
  return <span className={cls}>{n > 0 ? '+' : ''}{n.toFixed(2)}%</span>;
}

function fmt(v, decimals = 4) {
  if (v == null) return '—';
  const n = parseFloat(v);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10)   return n.toFixed(3);
  return n.toFixed(decimals);
}

function fmtVol(v) {
  if (!v) return '—';
  const n = parseFloat(v);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

export default function Stocks() {
  const [stocks, setStocks]       = useState([]);
  const [prices, setPrices]       = useState({});
  const [loading, setLoading]     = useState(true);
  const [priceLoading, setPriceLoading] = useState(false);
  const [filter, setFilter]       = useState('all');
  const [search, setSearch]       = useState('');
  const [lastUpdate, setLastUpdate] = useState(null);

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

  useEffect(() => {
    fetchPrices();
    const id = setInterval(fetchPrices, 30000);
    return () => clearInterval(id);
  }, [fetchPrices]);

  const categories = ['all', ...new Set(stocks.map(s => s.category))].sort();

  const displayed = stocks.filter(s => {
    if (filter !== 'all' && s.category !== filter) return false;
    if (search && !s.ticker.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const tvUrl = (ticker) =>
    `https://www.tradingview.com/chart/?symbol=BYBIT:${ticker}USDT.P`;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Stocks & ETFs</div>
          <div className="page-sub">
            {stocks.length} ativos · {lastUpdate ? `atualizado ${lastUpdate.toLocaleTimeString('pt-PT')}` : 'a carregar preços...'}
            {priceLoading && <span className="muted"> · ...</span>}
          </div>
        </div>
        <button className="btn-outline" onClick={fetchPrices} disabled={priceLoading}>
          {priceLoading ? '⟳' : '↻'} Refresh
        </button>
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
      </div>

      <div className="card">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Categoria</th>
                  <th>Preço (USDT)</th>
                  <th>24h %</th>
                  <th>24h High</th>
                  <th>24h Low</th>
                  <th>Volume 24h</th>
                  <th>Chart</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(s => {
                  const p = prices[s.ticker];
                  return (
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
                        {p ? fmt(p.price) : <span className="muted">—</span>}
                      </td>
                      <td>{pct(p?.change24h)}</td>
                      <td className="muted">{p ? fmt(p.high24h) : '—'}</td>
                      <td className="muted">{p ? fmt(p.low24h) : '—'}</td>
                      <td className="muted">{p ? fmtVol(p.volume24h) : '—'}</td>
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
