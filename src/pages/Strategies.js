import React, { useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';

const STRATEGY_META = {
  TrendSurfer: {
    description: 'Surfa tendências usando EMAs (12/30/80) com confirmação de RSI e volume. Só LONG — o scanner EMA90 garante uptrend diário.',
    tags: ['trend-following', 'EMA', 'RSI', 'volume'],
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
    description: 'Detecta breakouts das Bandas de Bollinger após períodos de baixa volatilidade. Entra quando o preço rompe a banda superior com volume confirmado.',
    tags: ['breakout', 'bollinger-bands', 'volatility', 'volume'],
    difficulty: 'Medium',
    source: 'Custom',
  },
  PumpBreaker: {
    description: 'Caça reversões de pump (SHORT). Entra quando o preço está acima da EMA200 no 1h e o RSI cruza abaixo da sua signal line com volume mínimo.',
    tags: ['reversal', 'RSI-cross', 'short', 'EMA200'],
    difficulty: 'Medium',
    source: 'Custom',
  },
  StockRSI: {
    description: 'Estratégia para Stocks & ETFs no 2h. Entra LONG ou SHORT quando o RSI(14) cruza a sua signal line (EMA9) com gap mínimo de 3 pontos.',
    tags: ['RSI-cross', 'stocks', 'ETF', 'long-short', '2h'],
    difficulty: 'Easy',
    source: 'Custom',
  },
  StockSMA: {
    description: 'Estratégia para Stocks & ETFs no 2h. Usa a SMA(18) do RSI(14): entra LONG ou SHORT quando a SMA inverte direção com pelo menos 0.8 pontos de diferença.',
    tags: ['RSI-SMA', 'inversão', 'stocks', 'ETF', 'long-short', '2h'],
    difficulty: 'Easy',
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

  const handleToggle = async (name, currentlyEnabled) => {
    const nextEnabled = !currentlyEnabled;
    setStrategies(prev => prev.map(s => (s.name === name ? { ...s, enabled: nextEnabled } : s)));
    try {
      await axios.post(`/api/strategies/${name}/toggle`, { enabled: nextEnabled });
    } catch (e) {
      console.error('Erro ao ligar/desligar estratégia:', e);
      setStrategies(prev => prev.map(s => (s.name === name ? { ...s, enabled: currentlyEnabled } : s)));
    }
  };

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

      {/* PROGRESSO / RESUMO */}
      {(runState.running || runState.summary) && (
        <div className="card" style={{ marginBottom: 20 }}>
          {runState.running ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="muted">
                  {runState.phase?.startsWith('scanner') ? (
                    <><span className="yellow">🔍 A correr scanner automático...</span></>
                  ) : (
                    <>{runState.strategy && <><strong style={{ color: 'var(--text)' }}>{runState.strategy}</strong> · </>}
                    {runState.current}/{runState.total} símbolos</>
                  )}
                </span>
                {runState.total > 0 && <span className="mono muted">{runPct}%</span>}
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: runState.phase?.startsWith('scanner') ? '100%' : `${runPct}%`, opacity: runState.phase?.startsWith('scanner') ? 0.4 : 1 }} />
              </div>
            </>
          ) : runState.summary && (
            <div className="run-summary">
              <span className="green">✅ Concluído</span>
              <span className="summary-pill">{runState.summary.analyzed} analisados</span>
              <span className="summary-pill signal">{runState.summary.signals} sinais</span>
              <span className="summary-pill">{runState.summary.holds} hold</span>
              {runState.summary.errors > 0 && <span className="summary-pill error">{runState.summary.errors} erros</span>}
              <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                {new Date(runState.summary.finishedAt).toLocaleTimeString('pt-PT')}
              </span>
            </div>
          )}
          {runState.log?.length > 0 && (
            <div className="run-log">
              {runState.log.slice(0, 30).map((line, i) => (
                <div key={i} className={`run-log-line ${line.startsWith('🔔') ? 'signal' : line.startsWith('❌') ? 'error' : line.startsWith('✅') ? 'success' : ''}`}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {['crypto', 'stock'].map(market => {
        const group = strategies.filter(s => (s.market || 'crypto') === market);
        if (!group.length) return null;
        return (
          <div key={market}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '24px 0 12px' }}>
              <span style={{ fontSize: 18 }}>{market === 'crypto' ? '🪙' : '📈'}</span>
              <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>
                {market === 'crypto' ? 'Cripto' : 'Stocks & ETFs'}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                {group.length} estratégia{group.length !== 1 ? 's' : ''}
              </span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>

            <div className="strategies-list">
              {group.map(s => {
                const meta = STRATEGY_META[s.name] || {};
                const st = stats[s.name] || {};
                const winRate    = parseFloat(st.win_rate    || 0);
                const totalPnl   = parseFloat(st.total_pnl_calc || 0);
                const totalTrades = parseInt(st.total_trades || 0);
                const openTrades  = parseInt(st.open_trades  || 0);

                return (
                  <div key={s.name} className="strategy-card">
                    <div className="strategy-header">
                      <div className="strategy-title-row">
                        <div className="strategy-name">{s.name}</div>
                        <div className="strategy-badges">
                          {meta.difficulty && <DifficultyBadge level={meta.difficulty} />}
                          <button
                            type="button"
                            className={`badge-toggle ${s.enabled ? 'badge-open' : 'badge-closed'}`}
                            onClick={() => handleToggle(s.name, s.enabled)}
                            title={s.enabled
                              ? 'Bybit ligado — clica para desligar as ordens reais (continua a gerar sinais e trades de estudo)'
                              : 'Só estudo — clica para ligar as ordens reais na Bybit'}
                          >
                            <span className="badge-toggle-dot" />
                            {s.enabled ? 'Bybit ON' : 'Só estudo'}
                          </button>
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
                        <span className="meta-label">Símbolos</span>
                        <span className="meta-value mono">
                          {s.symbolSource === 'stocks'
                            ? <span className="blue">{s.symbolCount} stocks/ETFs</span>
                            : s.scannerPeriod
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

                    {s.symbolSource === 'stocks' && s.symbolCount === 0 && (
                      <div className="scanner-warning">⚠️ Stock symbols não carregados ainda.</div>
                    )}
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
      })}
    </div>
  );
}
