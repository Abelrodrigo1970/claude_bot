import React, { useState } from 'react';
import Dashboard from './pages/Dashboard';
import Trades from './pages/Trades';
import Signals from './pages/Signals';
import './App.css';

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
          {['dashboard', 'trades', 'signals'].map(p => (
            <button
              key={p}
              className={`nav-btn ${page === p ? 'active' : ''}`}
              onClick={() => setPage(p)}
            >
              {p === 'dashboard' ? '📊 Dashboard' : p === 'trades' ? '📋 Trades' : '📡 Sinais'}
            </button>
          ))}
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && <Dashboard />}
        {page === 'trades' && <Trades />}
        {page === 'signals' && <Signals />}
      </main>
    </div>
  );
}

export default App;
