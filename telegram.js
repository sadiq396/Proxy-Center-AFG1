'use strict';
const crypto = require('crypto');
const store = require('./store');
const CONFIG = require('./config');

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) throw new Error('برای شناسایی تلگرام، BOT_TOKEN و initData معتبر لازم است.');
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get('hash');
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) throw new Error('امضای اطلاعات تلگرام معتبر نیست.');
  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(suppliedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('اعتبارسنجی امضای تلگرام ناموفق بود.');
  const authDate = Number(params.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || authDate > now + 60 || now - authDate > 86400) throw new Error('اطلاعات ورود تلگرام قدیمی است. مینی‌اپ را دوباره باز کنید.');
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { throw new Error('اطلاعات کاربر تلگرام قابل‌خواندن نیست.'); }
  if (!user || !user.id) throw new Error('شناسه کاربر از تلگرام دریافت نشد.');
  return user;
}

function upsertTelegramUser(raw) {
  const db = store.get();
  const id = String(raw.id);
  let user = store.getUser(id);
  const now = new Date().toISOString();
  if (!user) {
    user = { id, joined_at: now, blocked: false, created_via: 'telegram' };
    db.users.push(user);
  }
  user.first_name = String(raw.first_name || user.first_name || '').slice(0, 100);
  user.last_name = String(raw.last_name || user.last_name || '').slice(0, 100);
  user.username = String(raw.username || user.username || '').slice(0, 100);
  user.language_code = String(raw.language_code || user.language_code || '').slice(0, 20);
  user.last_seen = now;
  user.telegram_premium = !!raw.is_premium;
  return user;
}

function authMiddleware(req, res, next) {
  try {
    // Explicitly development-only; ignored in production even if misconfigured.
    const demoId = req.get('x-dev-user-id');
    if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEMO_LOGIN === 'true' && demoId) {
      const id = String(demoId).slice(0, 32);
      let user = store.getUser(id);
      if (!user) {
        user = { id, first_name: id === CONFIG.ADMIN_ID ? 'مدیر آزمایشی' : 'کاربر آزمایشی', username: '', joined_at: new Date().toISOString(), last_seen: new Date().toISOString(), blocked: false, created_via: 'local-demo' };
        store.get().users.push(user);
        store.save();
      }
      if (user.blocked) return res.status(403).json({ ok: false, error: 'دسترسی شما مسدود شده است.' });
      req.currentUser = user;
      return next();
    }
    const initData = req.get('x-telegram-init-data') || '';
    const raw = verifyInitData(initData, CONFIG.BOT_TOKEN);
    const user = upsertTelegramUser(raw);
    if (user.blocked) return res.status(403).json({ ok: false, error: 'دسترسی شما مسدود شده است.' });
    req.currentUser = user;
    store.save();
    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message || 'ورود تلگرام ناموفق بود.' });
  }
}

function adminMiddleware(req, res, next) {
  const adminId = CONFIG.ADMIN_ID;
  if (!req.currentUser || String(req.currentUser.id) !== adminId) return res.status(403).json({ ok: false, error: 'این بخش فقط برای مدیر اصلی است.' });
  return next();
}
module.exports = { verifyInitData, upsertTelegramUser, authMiddleware, adminMiddleware };
