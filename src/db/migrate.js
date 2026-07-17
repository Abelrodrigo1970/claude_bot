require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        strategy_name VARCHAR(100) NOT NULL,
        symbol VARCHAR(50) NOT NULL,
        side VARCHAR(10) NOT NULL,           -- 'long' | 'short'
        entry_price DECIMAL(20,8) NOT NULL,
        exit_price DECIMAL(20,8),
        quantity DECIMAL(20,8) NOT NULL,
        pnl DECIMAL(20,8),
        pnl_pct DECIMAL(10,4),
        status VARCHAR(20) DEFAULT 'open',   -- 'open' | 'closed' | 'cancelled'
        opened_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP,
        metadata JSONB DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        strategy_name VARCHAR(100) NOT NULL,
        symbol VARCHAR(50) NOT NULL,
        signal_type VARCHAR(20) NOT NULL,    -- 'long' | 'short' | 'close' | 'flip'
        price DECIMAL(20,8) NOT NULL,
        timeframe VARCHAR(10) NOT NULL,
        indicators JSONB DEFAULT '{}',
        acted_on BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS candles_cache (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(50) NOT NULL,
        timeframe VARCHAR(10) NOT NULL,
        open_time TIMESTAMP NOT NULL,
        open DECIMAL(20,8),
        high DECIMAL(20,8),
        low DECIMAL(20,8),
        close DECIMAL(20,8),
        volume DECIMAL(20,8),
        UNIQUE(symbol, timeframe, open_time)
      );

      CREATE TABLE IF NOT EXISTS strategy_stats (
        id SERIAL PRIMARY KEY,
        strategy_name VARCHAR(100) NOT NULL,
        symbol VARCHAR(50) NOT NULL,
        total_trades INT DEFAULT 0,
        winning_trades INT DEFAULT 0,
        total_pnl DECIMAL(20,8) DEFAULT 0,
        max_drawdown DECIMAL(10,4) DEFAULT 0,
        win_rate DECIMAL(10,4) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(strategy_name, symbol)
      );

      CREATE TABLE IF NOT EXISTS scanner_results (
        id         SERIAL PRIMARY KEY,
        ema_period INT            NOT NULL,
        rank       INT            NOT NULL,
        symbol     VARCHAR(50)    NOT NULL,
        price      DECIMAL(20,8)  NOT NULL,
        ema        DECIMAL(20,8)  NOT NULL,
        pct_above  DECIMAL(10,4)  NOT NULL,
        change_24h DECIMAL(10,4),
        volume     DECIMAL(20,8),
        scanned_at TIMESTAMP      NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS scanner_gainers (
        id         SERIAL PRIMARY KEY,
        rank       INT            NOT NULL,
        symbol     VARCHAR(50)    NOT NULL,
        price      DECIMAL(20,8)  NOT NULL,
        change_24h DECIMAL(10,4)  NOT NULL,
        volume     DECIMAL(20,8),
        scanned_at TIMESTAMP      NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS scanner_ema_trend (
        id         SERIAL PRIMARY KEY,
        rank       INT            NOT NULL,
        symbol     VARCHAR(50)    NOT NULL,
        price      DECIMAL(20,8)  NOT NULL,
        ema21_1d   DECIMAL(20,8)  NOT NULL,
        ema50_1d   DECIMAL(20,8)  NOT NULL,
        ema21_1h   DECIMAL(20,8)  NOT NULL,
        ema50_1h   DECIMAL(20,8)  NOT NULL,
        pct_above  DECIMAL(10,4)  NOT NULL,
        change_24h DECIMAL(10,4),
        volume     DECIMAL(20,8),
        scanned_at TIMESTAMP      NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS strategy_settings (
        strategy_name VARCHAR(100) PRIMARY KEY,
        enabled       BOOLEAN      NOT NULL DEFAULT true,
        updated_at    TIMESTAMP    DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stock_symbols (
        id           SERIAL PRIMARY KEY,
        symbol       VARCHAR(50)  NOT NULL UNIQUE,  -- formato Bybit: AAPL/USDT:USDT
        ticker       VARCHAR(20)  NOT NULL,          -- ticker curto: AAPL
        category     VARCHAR(20)  DEFAULT 'stock',   -- stock | etf | index | metal | commodity
        active       BOOLEAN      DEFAULT true,
        created_at   TIMESTAMP    DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_trades_strategy    ON trades(strategy_name);
      CREATE INDEX IF NOT EXISTS idx_trades_status      ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_signals_created    ON signals(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scanner_period_time ON scanner_results(ema_period, scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scanner_gainers_time ON scanner_gainers(scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scanner_ema_trend_time ON scanner_ema_trend(scanned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stock_symbols_active ON stock_symbols(active);
    `);
    console.log('✅ Migration completed successfully');
  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
