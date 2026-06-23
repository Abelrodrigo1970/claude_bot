# ⚡ CriptoBot

Bot de trading automático para Bybit com dashboard React + PostgreSQL (Railway).

## Stack
- **Backend**: Node.js + Express + CCXT + node-cron
- **Frontend**: React + Recharts
- **DB**: PostgreSQL via Railway
- **Exchange**: Bybit (Perpetual USDT)

## Estratégias incluídas

### TrendSurfer 🏄
Baseada no setup **Pivot Boss 4 EMA (12, 30, 80, 200)** + volume.
- **Entra LONG** quando EMA12 cruza acima EMA30 com EMAs alinhadas bullish + volume acima da média
- **Inverte para SHORT** automaticamente quando RSI > 70 + bearish crossover EMA12/30 + volume confirma
- **Surfa tanto a alta como a baixa** — sem stop, inverte de posição

## Setup

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Editar .env com as tuas credenciais
```

### 3. Criar as tabelas na DB
```bash
npm run db:migrate
```

### 4. Arrancar em desenvolvimento
```bash
npm run dev
# Backend: http://localhost:3001
# Frontend: http://localhost:3000
```

## Adicionar uma nova estratégia

1. Criar ficheiro em `src/strategies/minhaEstrategia.js`
2. Exportar `generateSignal(candles, currentPosition)` e `STRATEGY_NAME`
3. Adicionar ao array `STRATEGIES` em `src/services/runner.js`

## Deploy no Railway

1. Push para GitHub
2. Conectar repo no Railway
3. Adicionar PostgreSQL plugin
4. Definir as variáveis de ambiente
5. O Railway deteta automaticamente Node.js

## API Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /api/trades | Histórico de trades |
| GET | /api/signals | Sinais gerados |
| GET | /api/stats | Estatísticas por estratégia |
| GET | /api/pnl/daily | PnL diário para gráfico |
| POST | /api/run | Forçar execução manual |

## ⚠️ Aviso

Começa sempre com `BYBIT_TESTNET=true` e valida o comportamento antes de usar capital real.
