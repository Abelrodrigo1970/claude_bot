import React, { useState } from 'react';
import Dashboard from './pages/Dashboard';
import Trades from './pages/Trades';
import Signals from './pages/Signals';
import Strategies from './pages/Strategies';
import Scanner from './pages/Scanner';
import './App.css';

const PAGES = [
  { id: 'dashboard',   label: '📊 Dashboard' },
  { id: 'strategies',  label: '🧠 Estratégias' },
  { id: 'scanner',     label: '🔍 Scanner' },
  { id: 'trades',      label: '📋 Trades' },
  { id: 'signals',     label: '📡 Sinais' },
];

function App() {
  const [page, setPage] = useState('dashboard');

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">
          <span className="nav-icon">⚡</span>
          <span>CriptoBot</span>
        </div>
        <div className="nav-links">
          {PAGES.map(p => (
            <button
              key={p.id}
              className={`nav-btn ${page === p.id ? 'active' : ''}`}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard'  && <Dashboard />}
        {page === 'strategies' && <Strategies />}
        {page === 'scanner'    && <Scanner />}
        {page === 'trades'     && <Trades />}
        {page === 'signals'    && <Signals />}
      </main>
    </div>
  );
}

export default App;
