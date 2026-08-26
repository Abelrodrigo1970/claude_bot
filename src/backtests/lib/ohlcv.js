// A Bybit limita fetchOHLCV a 1000 velas por pedido (ver estudo de 90 dias
// da PullbackTrend, 14/08 — pedir mais devolve só as 1000 mais recentes,
// silenciosamente). Esta função pagina para trás com `since`, em blocos de
// até 1000, até juntar totalLimit velas ou esgotar o histórico disponível.
async function fetchOHLCVPaginated(exchange, symbol, timeframe, totalLimit) {
  const tfMs = exchange.parseTimeframe(timeframe) * 1000;
  let since = Date.now() - totalLimit * tfMs;
  let all = [];

  while (all.length < totalLimit) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, since, 1000);
    if (!batch.length) break;
    all = all.concat(batch);
    const lastTs = batch[batch.length - 1][0];
    if (batch.length < 1000) break; // já não há mais velas depois disto
    since = lastTs + tfMs;
    if (since > Date.now()) break;
  }

  // Remove duplicados (pode haver overlap na fronteira dos blocos) e corta às totalLimit mais recentes
  const seen = new Set();
  const dedup = [];
  for (const c of all) {
    if (seen.has(c[0])) continue;
    seen.add(c[0]);
    dedup.push(c);
  }
  dedup.sort((a, b) => a[0] - b[0]);
  return dedup.slice(-totalLimit);
}

module.exports = { fetchOHLCVPaginated };
