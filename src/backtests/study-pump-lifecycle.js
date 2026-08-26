// Estudo aprofundado: para todos os símbolos que já passaram pelo scanner
// Pump 24h, olha para o ciclo de vida completo — preço de entrada (1ª vez
// no scan), preço mínimo e máximo ao longo do tempo em que ficou no
// scanner, e preço de saída (última vez visto no scan, se já saiu; ou
// "ainda ativo" se continua no scan mais recente). Objetivo: encontrar
// padrões de timing (quando costuma acontecer o pico, quanto do ganho é
// devolvido antes de sair do scanner) para desenhar uma estratégia real.
//
// Corre com: node src/backtests/study-pump-lifecycle.js
const ccxt = require('ccxt');
const pool = require('../db/pool');

async function main() {
  const { rows: sessions } = await pool.query('SELECT DISTINCT scanned_at FROM scanner_pump ORDER BY scanned_at');
  const latestSession = sessions[sessions.length - 1].scanned_at;
  console.log(`Sessões no scanner: ${sessions.length} · primeira: ${sessions[0].scanned_at.toISOString()} · última: ${latestSession.toISOString()}`);

  const { rows } = await pool.query(`
    WITH fs AS (SELECT symbol, MIN(scanned_at) ts FROM scanner_pump GROUP BY symbol),
         ls AS (SELECT symbol, MAX(scanned_at) ts FROM scanner_pump GROUP BY symbol)
    SELECT sp1.symbol, sp1.scanned_at AS first_seen, sp1.price AS entry_price, sp1.rank AS entry_rank, sp1.change_24h AS entry_change24h,
           sp2.scanned_at AS last_seen, sp2.price AS exit_scan_price, sp2.rank AS exit_rank, sp2.change_24h AS exit_change24h
    FROM scanner_pump sp1
    JOIN fs ON sp1.symbol=fs.symbol AND sp1.scanned_at=fs.ts
    JOIN ls ON sp1.symbol=ls.symbol
    JOIN scanner_pump sp2 ON sp2.symbol=ls.symbol AND sp2.scanned_at=ls.ts
    ORDER BY fs.ts
  `);
  console.log(`Símbolos: ${rows.length}\n`);

  const exchange = new ccxt.bybit({ options: { defaultType: 'linear' } });
  await exchange.loadMarkets();

  const results = [];
  for (const r of rows) {
    const firstSeen = new Date(r.first_seen);
    const lastSeen = new Date(r.last_seen);
    const stillActive = lastSeen.getTime() === latestSession.getTime();
    const windowEnd = stillActive ? new Date() : lastSeen;
    const hoursWindow = (windowEnd - firstSeen) / 3600000;
    const candlesNeeded = Math.min(Math.ceil(hoursWindow * 12) + 5, 1000);

    try {
      const ohlcv = await exchange.fetchOHLCV(r.symbol, '5m', undefined, candlesNeeded);
      const candles = ohlcv
        .map(([time, open, high, low, close]) => ({ time: new Date(time), high, low, close }))
        .filter(c => c.time >= firstSeen && c.time <= windowEnd);
      if (!candles.length) { process.stdout.write('x'); continue; }

      let maxC = candles[0], minC = candles[0];
      for (const c of candles) {
        if (c.high > maxC.high) maxC = c;
        if (c.low < minC.low) minC = c;
      }

      const entryPrice = parseFloat(r.entry_price);
      const exitScanPrice = parseFloat(r.exit_scan_price);
      const lastClose = candles[candles.length - 1].close;

      results.push({
        symbol: r.symbol.split('/')[0],
        entryRank: r.entry_rank,
        entryChange24h: parseFloat(r.entry_change24h),
        entryPrice,
        maxPrice: maxC.high,
        maxTime: maxC.time,
        hoursToMax: (maxC.time - firstSeen) / 3600000,
        minPrice: minC.low,
        minTime: minC.time,
        hoursToMin: (minC.time - firstSeen) / 3600000,
        exitScanPrice,
        exitRank: r.exit_rank,
        stillActive,
        hoursInScanner: (windowEnd - firstSeen) / 3600000,
        lastClose,
        pctToMax: ((maxC.high - entryPrice) / entryPrice) * 100,
        pctToMin: ((minC.low - entryPrice) / entryPrice) * 100,
        pctEntryToScanExit: ((exitScanPrice - entryPrice) / entryPrice) * 100,
        pctEntryToNow: ((lastClose - entryPrice) / entryPrice) * 100,
        maxBeforeMin: maxC.time < minC.time,
      });
      process.stdout.write('.');
    } catch (err) {
      process.stdout.write('x');
    }
  }
  console.log(`\n\n${results.length}/${rows.length} símbolos com dados válidos.\n`);

  console.log('===== CICLO DE VIDA COMPLETO (ordenado por hora de entrada) =====');
  console.table(results.map(r => ({
    symbol: r.symbol,
    rankEntrada: r.entryRank,
    entrada: r.entryPrice,
    max: r.maxPrice.toFixed(6),
    pctMax: (r.pctToMax >= 0 ? '+' : '') + r.pctToMax.toFixed(1) + '%',
    hAteMax: r.hoursToMax.toFixed(1),
    min: r.minPrice.toFixed(6),
    pctMin: r.pctToMin.toFixed(1) + '%',
    hAteMin: r.hoursToMin.toFixed(1),
    situacao: r.stillActive ? 'ativo' : 'saiu',
    pctNoFimDoScan: (r.stillActive ? r.pctEntryToNow : r.pctEntryToScanExit).toFixed(1) + '%',
    ordemMaxMin: r.maxBeforeMin ? 'max→min' : 'min→max',
  })));

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  console.log('\n===== AGREGADO GLOBAL =====');
  console.table([{
    simbolos: results.length,
    pctMaxMedio: '+' + avg(results.map(r => r.pctToMax)).toFixed(1) + '%',
    pctMaxMediano: '+' + median(results.map(r => r.pctToMax)).toFixed(1) + '%',
    hAteMaxMedio: avg(results.map(r => r.hoursToMax)).toFixed(1) + 'h',
    pctMinMedio: avg(results.map(r => r.pctToMin)).toFixed(1) + '%',
    hAteMinMedio: avg(results.map(r => r.hoursToMin)).toFixed(1) + 'h',
    pctMaxAcimaDeMin: ((results.filter(r => r.maxBeforeMin === false).length / results.length) * 100).toFixed(0) + '%',
    aindaAtivos: results.filter(r => r.stillActive).length,
    jaSairam: results.filter(r => !r.stillActive).length,
  }]);

  const exited = results.filter(r => !r.stillActive);
  if (exited.length) {
    console.log('\n===== SÓ OS QUE JÁ SAÍRAM DO SCANNER — devolveram quanto do pico? =====');
    const captureRatios = exited.map(r => {
      const gainAtPeak = r.maxPrice - r.entryPrice;
      const gainAtExit = r.exitScanPrice - r.entryPrice;
      return gainAtPeak > 0 ? (gainAtExit / gainAtPeak) * 100 : null;
    }).filter(v => v !== null);
    console.table([{
      simbolosSaidos: exited.length,
      pctEntradaSaidaMedio: avg(exited.map(r => r.pctEntryToScanExit)).toFixed(1) + '%',
      pctEntradaSaidaMediano: median(exited.map(r => r.pctEntryToScanExit)).toFixed(1) + '%',
      capturaDoPicoMedia: captureRatios.length ? avg(captureRatios).toFixed(0) + '%' : 'N/A',
      pctQueSaemNoVerde: ((exited.filter(r => r.pctEntryToScanExit > 0).length / exited.length) * 100).toFixed(0) + '%',
      pctQueSaemNoVermelho: ((exited.filter(r => r.pctEntryToScanExit < 0).length / exited.length) * 100).toFixed(0) + '%',
    }]);
  }

  console.log('\n===== DISTRIBUIÇÃO: QUANTAS HORAS ATÉ AO PICO =====');
  const buckets = [[0, 1], [1, 2], [2, 4], [4, 8], [8, 16], [16, 1000]];
  console.table(buckets.map(([lo, hi]) => {
    const c = results.filter(r => r.hoursToMax >= lo && r.hoursToMax < hi).length;
    return { intervalo: hi === 1000 ? `${lo}h+` : `${lo}-${hi}h`, simbolos: c, pct: ((c / results.length) * 100).toFixed(1) + '%' };
  }));

  console.log('\n===== RANK DE ENTRADA vs. RESULTADO =====');
  const byRankBucket = [[1, 3], [4, 6], [7, 10], [11, 1000]];
  console.table(byRankBucket.map(([lo, hi]) => {
    const rs = results.filter(r => r.entryRank >= lo && r.entryRank <= (hi === 1000 ? 9999 : hi));
    if (!rs.length) return { rank: `${lo}-${hi === 1000 ? '+' : hi}`, simbolos: 0 };
    return {
      rank: `${lo}-${hi === 1000 ? '+' : hi}`,
      simbolos: rs.length,
      pctMaxMedio: '+' + avg(rs.map(r => r.pctToMax)).toFixed(1) + '%',
      pctMinMedio: avg(rs.map(r => r.pctToMin)).toFixed(1) + '%',
    };
  }));

  await pool.end();
}

main().catch(err => { console.error('Erro no estudo:', err); process.exit(1); });
