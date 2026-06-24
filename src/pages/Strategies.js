import React, { useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';

const STRATEGY_META = {
  TrendSurfer: {
    description: 'Surfa tendências usando 4 EMAs (12/30/80/200) com confirmação de volume e RSI. Inverte posição automaticamente no topo e fundo.',
    tags: ['trend-following', 'EMA', 'RSI', 'volume', 'flip'],
    difficulty: 'Medium',
    source: 'Custom',
  },
  MACDRider: {
    description: 'Entra em tendências usando o cruzamento da linha MACD com a linha de sinal, filtrado pela EMA200 para garantir alinhamento com a tendência macro.',
    tags: ['trend-following', 'MACD', 'EMA200', 'crossover'],
    difficulty: 'Easy',
    source: 'Custom',
  },
  BBBreaker: {
    description: 'Detecta breakouts das Bandas de Bollinger após períodos de baixa volatilidade (squeeze). Entra quando o preço rompe a banda com confirmação de volume.',
    tags: ['breakout', 'bollinger-bands', 'volatility', 'volume', 'squeeze'],
    difficulty: 'Medium',
    source: 'Custom',
  },
  StochMomentum: {
    description: 'Combina o Estocástico (14,3) com EMAs de curto e médio prazo para entrar em reversões de momento em zonas de sobrecompra/sobrevenda com tendência favorável.',
    tags: ['momentum', 'stochastic', 'mean-reversion', 'EMA', 'scalping'],
    difficulty: 'Medium',
    source: 'Custom',
  },
};

function DifficultyBadge({ level }) {
  const colors = { Easy: 'green', Medium: 'yellow', Hard: 'red' };
  return <span className={`badge badge-diff-${level.toLowerCase()}`}>{level}</span>;
}

function StarRating({ winRate }) {
  const stars = winRate >= 70 ? 3 : winRate >= 50 ? 2 : 1;
  return (
    <span className="star-rating" title={`Win rate: ${winRate?.toFixed(1) ?? '—'}%`}>
      {'★'.repeat(stars)}{'☆'.repeat(3 - stars)}
    </span>
  );
}

export default function Strategies() {
  const [strategies, setStrategies] = useState([]);
  const [stats, setStats]           = useState({});
  const [runState, setRunState]     = useState({ running: false, strategy: null, current: 0, total: 0, log: [] });
  const [loading, setLoading]       = useState(true);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const s = await axios.get('/api/strategies');
      setStrategies(s.data);
    } catch (e) {
      console.error('Erro ao carregar estratégias:', e);
    }

    try {
      const st = await axios.get('/api/stats');
      const statsMap = {};
      st.data.forEach(row => { statsMap[row.strategy_name] = row; });
      setStats(statsMap);
    } catch {
      // stats podem falhar se BD ainda não está configurada
    }

    setLoading(false);
  }, []);

  const pollRunState = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/run/state');
      setRunState(data);
      if (!data.running) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        load();
      }
    } catch { clearInterval(pollRef.current); pollRef.current = null; }
  }, [load]);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    if (runState.running) return;
    axios.post('/api/run'); // fire-and-forget
    setRunState(s => ({ ...s, running: true }));
    clearInterval(pollRef.current);
    pollRef.current = setInterval(pollRunState, 1500);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  if (loading) return <div className="loading"><div className="spinner" /><span>A carregar...</span></div>;

  const runPct = runState.total > 0 ? Math.round((runState.current / runState.total) * 100) : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Estratégias</div>
          <div className="page-sub">{strategies.length} estratégia{strategies.length !== 1 ? 's' : ''} configurada{strategies.length !== 1 ? 's' : ''}</div>
        </div>
        <button className="btn btn-primary" onClick={handleRun} disabled={runState.running}>
          {runState.running ? '⏳ A executar...' : '▶ Executar Todas'}
        </button>
      </div>

      {/* BARRA DE PROGRESSO GLOBAL */}
      {runState.running && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="muted">
              {runState.strategy && <><strong style={{ color: 'var(--text)' }}>{runState.strategy}</strong> · </>}
              {runState.current}/{runState.total} símbolos
            </span>
            <span className="mono muted">{runPct}%</span>
          </div>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${runPct}%` }} /></div>
          {runState.log?.[0] && (
            <div className="run-log-line muted">{runState.log[0]}</div>
          )}
        </div>
      )}

      <div className="strategies-list">
        {strategies.map(s => {
          const meta = STRATEGY_META[s.name] || {};
          const st = stats[s.name] || {};
          const winRate = parseFloat(st.win_rate || 0);
          const totalPnl = parseFloat(st.total_pnl_calc || 0);
          const totalTrades = parseInt(st.total_trades || 0);
          const openTrades = parseInt(st.open_trades || 0);

          return (
            <div key={s.name} className={`strategy-card ${!s.enabled ? 'disabled' : ''}`}>
              <div className="strategy-header">
                <div className="strategy-title-row">
                  <div className="strategy-name">{s.name}</div>
                  <div className="strategy-badges">
                    {meta.difficulty && <DifficultyBadge level={meta.difficulty} />}
                    <span className={`badge ${s.enabled ? 'badge-open' : 'badge-closed'}`}>
                      {s.enabled ? 'Ativa' : 'Inativa'}
                    </span>
                    {meta.source && <span className="badge badge-hold">{meta.source}</span>}
                  </div>
                </div>
                <StarRating winRate={winRate} />
              </div>

              <p className="strategy-desc">{meta.description || 'Sem descrição.'}</p>

              <div className="strategy-tags">
                {(meta.tags || []).map(tag => (
                  <span key={tag} className="tag">#{tag}</span>
                ))}
              </div>

              <div className="strategy-meta-row">
                <span className="meta-item">
                  <span className="meta-label">Par</span>
                  <span className="meta-value mono">
                    {s.scannerPeriod
                      ? <span className="green">TOP {s.symbolCount} · EMA{s.scannerPeriod}</span>
                      : s.symbol?.split('/')[0]}
                  </span>
                </span>
                <span className="meta-item">
                  <span className="meta-label">Timeframe</span>
                  <span className="meta-value mono">{s.timeframe}</span>
                </span>
                <span className="meta-item">
                  <span className="meta-label">Trades</span>
                  <span className="meta-value mono">{totalTrades}</span>
                </span>
                <span className="meta-item">
                  <span className="meta-label">Win Rate</span>
                  <span className={`meta-value mono ${winRate >= 50 ? 'green' : winRate > 0 ? 'red' : ''}`}>
                    {totalTrades > 0 ? `${winRate.toFixed(1)}%` : '—'}
                  </span>
                </span>
                <span className="meta-item">
                  <span className="meta-label">PnL Total</span>
                  <span className={`meta-value mono ${totalPnl >= 0 ? 'green' : 'red'}`}>
                    {totalTrades > 0 ? `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDT` : '—'}
                  </span>
                </span>
                <span className="meta-item">
                  <span className="meta-label">Abertas</span>
                  <span className="meta-value mono blue">{openTrades}</span>
                </span>
              </div>

              {s.scannerPeriod && s.symbolCount === 0 && (
                <div className="scanner-warning">
                  ⚠️ Corre o Scanner EMA{s.scannerPeriod} primeiro para carregar os símbolos.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
