import React, { useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';
import { format } from 'date-fns';

const STRATEGY_META = {
  TrendSurfer: {
    description: 'Surfa tendências usando EMAs (12/30/80) com confirmação de RSI e volume. Só LONG — o scanner EMA90 garante uptrend diário.',
    tags: ['trend-following', 'EMA', 'RSI', 'volume'],
    difficulty: 'Medium',
    source: 'Custom',
  },
  StockSMA: {
    description: 'Estratégia para Stocks & ETFs no 2h. Usa a SMA(18) do RSI(14): entra LONG ou SHORT quando a SMA inverte direção com pelo menos 0.8 pontos de diferença.',
    tags: ['RSI-SMA', 'inversão', 'stocks', 'ETF', 'long-short', '2h'],
    difficulty: 'Easy',
    source: 'Custom',
  },
  Stoch50: {
    description: 'Stocks & ETFs no 1h (universo reduzido, exclui os 20 piores do backtest). Stochastic lento (%K 50, suavização 40, %D 11): compra quando %K cruza acima de %D, vende quando cruza abaixo — sem filtro, qualquer cruzamento inverte a posição. TP parcial 50% a +15% em ambos os lados.',
    tags: ['stochastic', 'K50', 'cruzamento', 'stocks', 'take-profit-parcial', '1h'],
    difficulty: 'Medium',
    source: 'Custom',
  },
  EMA90TopFade: {
    description: 'Cripto, diário. SHORT quando o símbolo entra no top 8 do ranking "% acima da EMA90" (aposta que o pump está esticado) — só se o RSI(14) diário ainda não estiver extremo (<72) e o QQQ (proxy Nasdaq) não estiver em alta nesse dia. Fecha e inverte para LONG quando sai do top 8 (compra o recuo). SL 26% — testado propositadamente largo, qualquer SL entre 5-20% piorou o resultado nos dados históricos.',
    tags: ['EMA90', 'ranking', 'fade', 'RSI', 'filtro-QQQ', 'long-short', '1d'],
    difficulty: 'Hard',
    source: 'Custom',
  },
  StockEma1270Cross: {
    description: 'Stocks no 1h, cruzamento EMA12/EMA70: sempre no mercado, inverte de posição a cada cruzamento (cima=LONG, baixo=SHORT). Lista curada de 15 tickers (NBIS, AXTI, MRVL, COHR, ASTS, AAOI, RKLB, HPE, USAR, SMCI, GLW, GOOGL, MSFT, BABA, META) — o universo completo de 74 perdia dinheiro, este subconjunto deu profit factor ~2. TP parcial 50% a +19%, sem SL (qualquer SL fixo piorou o resultado nos backtests).',
    tags: ['EMA12', 'EMA70', 'cruzamento', 'stocks', 'lista-curada', 'take-profit-parcial', 'long-short', '1h'],
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

// Painel expansível de trades de UMA estratégia — pedido do utilizador
// (26/09: lista simples de trades; 27/09: reorganizado em análise — nº de
// trades fechados, top 10 melhores/piores, evolução diária e abertos).

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '18px 0 8px' }}>
      {children}
    </div>
  );
}

function TradesMiniTable({ trades, showPnl = true, emptyLabel = 'Nenhum trade.' }) {
  if (!trades.length) return <div className="empty" style={{ padding: '10px 0' }}>{emptyLabel}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Par</th>
            <th>Side</th>
            <th>Entrada</th>
            <th>Saída</th>
            {showPnl && <><th>PnL (USDT)</th><th>PnL %</th></>}
            <th>Aberto</th>
            <th>Fechado</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(t => {
            const pnl = parseFloat(t.pnl || 0);
            const pnlPct = parseFloat(t.pnl_pct || 0);
            return (
              <tr key={t.id}>
                <td style={{ color: '#e2e8f0' }}>{t.symbol.split('/')[0]}/USDT</td>
                <td><span className={`badge badge-${t.side}`}>{t.side.toUpperCase()}</span></td>
                <td className="mono">{parseFloat(t.entry_price).toFixed(6)}</td>
                <td className="mono">{t.exit_price ? parseFloat(t.exit_price).toFixed(6) : <span className="muted">—</span>}</td>
                {showPnl && (
                  <>
                    <td className={pnl >= 0 ? 'green' : 'red'}>
                      {t.status === 'closed' ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}` : <span className="muted">—</span>}
                    </td>
                    <td className={pnlPct >= 0 ? 'green' : 'red'}>
                      {t.status === 'closed' ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : <span className="muted">—</span>}
                    </td>
                  </>
                )}
                <td className="muted">{format(new Date(t.opened_at), 'dd/MM HH:mm')}</td>
                <td className="muted">{t.closed_at ? format(new Date(t.closed_at), 'dd/MM HH:mm') : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Agrupa trades FECHADOS por dia (closed_at, data local do browser) — mais
// recente primeiro. PnL acumulado é sempre calculado em ordem cronológica
// (mais antigo → mais recente), independente da ordem de exibição.
function DailyEvolutionTable({ closedTrades }) {
  if (!closedTrades.length) return <div className="empty" style={{ padding: '10px 0' }}>Sem trades fechados ainda.</div>;

  const byDay = {};
  closedTrades.forEach(t => {
    const day = format(new Date(t.closed_at), 'yyyy-MM-dd');
    (byDay[day] ??= []).push(t);
  });

  let cumulative = 0;
  const rows = Object.keys(byDay).sort().map(day => {
    const dayTrades = byDay[day];
    const pnlDay = dayTrades.reduce((a, t) => a + parseFloat(t.pnl || 0), 0);
    const wins = dayTrades.filter(t => parseFloat(t.pnl || 0) > 0).length;
    cumulative += pnlDay;
    return { day, trades: dayTrades.length, wins, pnlDay, cumulative };
  }).reverse();

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Dia</th>
            <th>Trades</th>
            <th>Win Rate</th>
            <th>PnL do Dia</th>
            <th>PnL Acumulado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const [y, m, d] = r.day.split('-');
            return (
              <tr key={r.day}>
                <td className="mono">{d}/{m}/{y}</td>
                <td className="mono muted">{r.trades}</td>
                <td className="mono">{((r.wins / r.trades) * 100).toFixed(0)}%</td>
                <td className={`mono ${r.pnlDay >= 0 ? 'green' : 'red'}`}>{r.pnlDay >= 0 ? '+' : ''}{r.pnlDay.toFixed(4)}</td>
                <td className={`mono ${r.cumulative >= 0 ? 'green' : 'red'}`}>{r.cumulative >= 0 ? '+' : ''}{r.cumulative.toFixed(4)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StrategyTradesPanel({ trades }) {
  const closed = trades.filter(t => t.status === 'closed');
  const open = trades.filter(t => t.status === 'open');
  const wins = closed.filter(t => parseFloat(t.pnl || 0) > 0).length;
  const best10 = [...closed].sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl)).slice(0, 10);
  const worst10 = [...closed].sort((a, b) => parseFloat(a.pnl) - parseFloat(b.pnl)).slice(0, 10);

  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>
        {closed.length} trade{closed.length !== 1 ? 's' : ''} fechado{closed.length !== 1 ? 's' : ''} ·{' '}
        {wins} vencedor{wins !== 1 ? 'es' : ''} ({closed.length ? ((wins / closed.length) * 100).toFixed(1) : '0.0'}%) ·{' '}
        {open.length} aberta{open.length !== 1 ? 's' : ''}
      </div>

      <SectionLabel>Trades Abertos ({open.length})</SectionLabel>
      <TradesMiniTable trades={open} showPnl={false} emptyLabel="Nenhuma posição aberta." />

      <SectionLabel>Top 10 Melhores Trades</SectionLabel>
      <TradesMiniTable trades={best10} emptyLabel="Sem trades fechados ainda." />

      <SectionLabel>Top 10 Piores Trades</SectionLabel>
      <TradesMiniTable trades={worst10} emptyLabel="Sem trades fechados ainda." />

      <SectionLabel>Evolução Diária</SectionLabel>
      <DailyEvolutionTable closedTrades={closed} />
    </div>
  );
}

export default function Strategies() {
  const [strategies, setStrategies] = useState([]);
  const [stats, setStats]           = useState({});
  const [runState, setRunState]     = useState({ running: false, strategy: null, current: 0, total: 0, log: [] });
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState({});   // { [strategyName]: bool }
  const [tradesBySt, setTradesBySt] = useState({});   // { [strategyName]: trade[] }
  const [tradesLoading, setTradesLoading] = useState({}); // { [strategyName]: bool }
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

  const toggleExpanded = async (name) => {
    const nowExpanded = !expanded[name];
    setExpanded(prev => ({ ...prev, [name]: nowExpanded }));
    if (nowExpanded && !tradesBySt[name]) {
      setTradesLoading(prev => ({ ...prev, [name]: true }));
      try {
        const { data } = await axios.get(`/api/trades?strategy=${encodeURIComponent(name)}&limit=500`);
        setTradesBySt(prev => ({ ...prev, [name]: data }));
      } catch (e) {
        console.error(`Erro ao carregar trades de ${name}:`, e);
        setTradesBySt(prev => ({ ...prev, [name]: [] }));
      } finally {
        setTradesLoading(prev => ({ ...prev, [name]: false }));
      }
    }
  };

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
                              : s.symbolSource === 'emaTrendTotal'
                                ? <span className="green">{s.symbolCount} · EMA Trend</span>
                                : s.symbols?.length
                                  ? <span className="blue">{s.symbolCount} símbolos (lista fixa)</span>
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

                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ marginTop: 12, fontSize: 12 }}
                      onClick={() => toggleExpanded(s.name)}
                      disabled={totalTrades === 0}
                    >
                      {expanded[s.name] ? '▲ Esconder trades' : `▼ Ver trades${totalTrades > 0 ? ` (${totalTrades})` : ''}`}
                    </button>

                    {expanded[s.name] && (
                      <div style={{ marginTop: 12 }}>
                        {tradesLoading[s.name] ? (
                          <div className="loading"><div className="spinner" /></div>
                        ) : (
                          <StrategyTradesPanel trades={tradesBySt[s.name] || []} />
                        )}
                      </div>
                    )}

                    {s.symbolSource === 'stocks' && s.symbolCount === 0 && (
                      <div className="scanner-warning">⚠️ Stock symbols não carregados ainda.</div>
                    )}
                    {s.scannerPeriod && s.symbolCount === 0 && (
                      <div className="scanner-warning">
                        ⚠️ Corre o Scanner EMA{s.scannerPeriod} primeiro para carregar os símbolos.
                      </div>
                    )}
                    {s.symbolSource === 'emaTrendTotal' && s.symbolCount === 0 && (
                      <div className="scanner-warning">⚠️ Corre o Scanner EMA Trend primeiro para carregar os símbolos.</div>
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
