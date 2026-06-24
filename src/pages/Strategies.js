import React, { useEffect, useState, useCallback } from 'react';
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
  const [stats, setStats] = useState({});
  const [running, setRunning] = useState(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => { load(); }, [load]);

  const handleRun = async (name) => {
    setRunning(name);
    try { await axios.post('/api/run'); await load(); }
    finally { setRunning(null); }
  };

  if (loading) return <div className="loading"><div className="spinner" /><span>A carregar...</span></div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Estratégias</div>
          <div className="page-sub">{strategies.length} estratégia{strategies.length !== 1 ? 's' : ''} configurada{strategies.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

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
                  <span className="meta-value mono">{s.symbol}</span>
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

              <div className="strategy-footer">
                <button
                  className="btn btn-primary"
                  onClick={() => handleRun(s.name)}
                  disabled={running === s.name || !s.enabled}
                >
                  {running === s.name ? '⏳ A executar...' : '▶ Executar'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
