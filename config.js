'use strict';

// Project defaults are embedded here as requested. The embedded Telegram token
// was revoked by the owner and will NOT authenticate with Telegram. Replace it
// with a fresh token via BOT_TOKEN in the host's secret/environment settings.
const REVOKED_TEST_BOT_TOKEN = '8814745943:AAGw-S5k1pNLfeHFswCquu_CYCi-NdTixNQ';

module.exports = Object.freeze({
  BOT_TOKEN: process.env.BOT_TOKEN || REVOKED_TEST_BOT_TOKEN,
  WEBAPP_URL: process.env.WEBAPP_URL || process.env.APP_URL || '',
  ADMIN_ID: String(process.env.ADMIN_ID || '6891242026'),
  SUPPORT_USERNAME: String(process.env.SUPPORT_USERNAME || 'sadiq_AFG1').replace(/^@/, ''),
  PROVIDER_FANCY: process.env.PROVIDER_FANCY || '︎ ︎ ︎︎ ׄ𓏴︎ ︎︎ׄ︎︎︎𝑀𝑢ℎ𝑎𝑚𝑚𝑎𝑑𝒔𝒂𝒅𝒊𝒒 ︎ ͜︎ ︎ ͜ ⸝⸝︎𓀦𓊇',
  PROVIDER_NAME: process.env.PROVIDER_NAME || 'محمدصادق افغان',
  BOT_POLLING_ENABLED: process.env.BOT_POLLING_ENABLED === 'true'
});
