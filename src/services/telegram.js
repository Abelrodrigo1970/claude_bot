// Envio de alertas via Telegram Bot API — usa axios (já é dependência do
// projeto), sem SDK extra. Fica silencioso (só um aviso na consola, uma
// única vez) se TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não estiverem definidos
// no .env, para nunca bloquear o scanner por falta de configuração.
require('dotenv').config();
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

let warnedMissingConfig = false;

async function sendMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    if (!warnedMissingConfig) {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não configurados — alertas desligados.');
      warnedMissingConfig = true;
    }
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.warn('[Telegram] Falha ao enviar mensagem:', err.response?.data?.description || err.message);
  }
}

module.exports = { sendMessage };
