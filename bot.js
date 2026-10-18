'use strict';
const store = require('./store');
const { upsertTelegramUser } = require('./telegram');
const CONFIG = require('./config');
const TOKEN = CONFIG.BOT_TOKEN;
const WEBAPP_URL = CONFIG.WEBAPP_URL;
const POLLING_ENABLED = CONFIG.BOT_POLLING_ENABLED;
let stopping = false;
let started = false;
let offset = 0;
const api = method => `https://api.telegram.org/bot${TOKEN}/${method}`;
async function call(method, payload, timeout = 10_000) {
  const r = await fetch(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(timeout) });
  const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.description || `Telegram API ${r.status}`); return j.result;
}
async function sendStart(chatId, from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'دوست عزیز';
  const text = `سلام ${name}! 👋\nبه Proxy Center AFG خوش آمدی.\n\nبرای دریافت کانفیگ‌ها، بررسی اتصال و استفاده از بخش‌های برنامه، مینی‌اپ را باز کن.`;
  const markup = WEBAPP_URL.startsWith('https://') ? { inline_keyboard: [[{ text: '🚀 باز کردن مینی‌اپ', web_app: { url: WEBAPP_URL } }]] } : undefined;
  await call('sendMessage', { chat_id: chatId, text: markup ? text : `${text}\n\nمدیر هنوز WEBAPP_URL را با آدرس HTTPS تنظیم نکرده است.`, ...(markup ? { reply_markup: markup } : {}) });
  // Contact sharing is optional and user-initiated. Telegram only returns the contact after the user taps the button.
  await call('sendMessage', { chat_id: chatId, text: 'برای نمایش شماره در بخش مدیریت، در صورت تمایل دکمه زیر را بزن. اشتراک شماره کاملاً اختیاری است.', reply_markup: { keyboard: [[{ text: '📱 اشتراک شماره (اختیاری)', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
}
async function poll() {
  if (stopping) return;
  try {
    const updates = await call('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] }, 27_000);
    for (const update of updates || []) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!message?.from || !message.chat || message.chat.type !== 'private') continue;
      const user = upsertTelegramUser(message.from);
      if (message.contact && String(message.contact.user_id || '') === String(message.from.id) && message.contact.phone_number) {
        user.phone_number = String(message.contact.phone_number).slice(0, 40);
        await store.save();
        try { await call('sendMessage', { chat_id: message.chat.id, text: 'شماره تلفن با رضایت شما ثبت شد. هر زمان بخواهی، می‌توانی آن را از بخش پروفایل حذف کنی.' }); } catch {}
        continue;
      }
      await store.save();
      const text = String(message.text || '').trim();
      if (/^\/(start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
        try { await sendStart(message.chat.id, message.from); } catch (err) { console.error('[bot] send failed:', err.message); }
      }
    }
  } catch (err) {
    if (!/409|Conflict/.test(err.message)) console.error('[bot] polling issue:', err.message);
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  setImmediate(poll);
}
function startBot() {
  if (!POLLING_ENABLED) { console.log('[bot] BOT_POLLING_ENABLED is not true; bot polling is disabled on this instance.'); return; }
  if (started || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(TOKEN) || TOKEN === 'REPLACE_WITH_NEW_BOT_TOKEN' || TOKEN === '8814745943:AAGw-S5k1pNLfeHFswCquu_CYCi-NdTixNQ') {
    if (!TOKEN) console.log('[bot] BOT_TOKEN is empty; Telegram bot polling is disabled.');
    return;
  }
  started = true;
  if (!WEBAPP_URL.startsWith('https://')) console.warn('[bot] WEBAPP_URL must be a public HTTPS URL to enable the Mini App button.');
  else call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'باز کردن مینی‌اپ', web_app: { url: WEBAPP_URL } } }).catch(err => console.error('[bot] menu button setup failed:', err.message));
  poll();
  console.log('[bot] Telegram polling enabled. Make sure only one running instance uses this token.');
}
function stopBot() { stopping = true; }
module.exports = { startBot, stopBot, sendMessage: async (chatId, text) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) }) };
