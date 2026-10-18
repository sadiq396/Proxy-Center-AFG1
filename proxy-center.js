'use strict';
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { authMiddleware, adminMiddleware } = require('./telegram');
const { getConfigs } = require('./configs');
const CONFIG = require('./config');

const ADMIN_ID = CONFIG.ADMIN_ID;
const SUPPORT_USERNAME = CONFIG.SUPPORT_USERNAME;
const PROVIDER_FANCY = CONFIG.PROVIDER_FANCY;
const PROVIDER_NAME = CONFIG.PROVIDER_NAME;
const publicDir = path.resolve(__dirname, '..', 'public');
const limits = new Map();
// Process-local presence heartbeat. Active users expire after 70 seconds.
const onlineUsers = new Map();
const ONLINE_TTL_MS = 70_000;

function rateLimit({ windowMs = 60_000, max = 100 } = {}) {
  return (req, res, next) => {
    const key = `${req.currentUser?.id || req.ip}:${req.path}`;
    const now = Date.now();
    let item = limits.get(key);
    if (!item || now > item.until) item = { count: 0, until: now + windowMs };
    item.count++;
    limits.set(key, item);
    if (limits.size > 5000) for (const [k, v] of limits) if (now > v.until) limits.delete(k);
    if (item.count > max) return res.status(429).json({ ok: false, error: 'درخواست‌ها بیش از حد زیاد است. کمی بعد دوباره تلاش کنید.' });
    next();
  };
}
function cleanText(value, max = 1000) { return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max); }
function getCurrentUser(userId) { return store.getUser(String(userId)); }
function messageShape(m) {
  const u = getCurrentUser(m.user_id);
  return { id: m.id, user_id: String(m.user_id), name: m.name || [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'کاربر', username: m.username || u?.username || '', text: m.text, reply_to: m.reply_to || null, created_at: m.created_at, edited_at: m.edited_at || null, is_admin: String(m.user_id) === ADMIN_ID };
}
function ticketShape(t) {
  const u = getCurrentUser(t.user_id);
  return { id: t.id, user_id: String(t.user_id), user_name: [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'کاربر', username: u?.username || '', subject: t.subject, status: t.status, created_at: t.created_at, updated_at: t.updated_at, messages: (t.messages || []).map(m => ({ ...m, is_admin: m.sender_id === 'admin' })) };
}
function addMessageNotification(target, type, title, body, metadata) { store.addNotification(String(target), type, title, body, metadata); }
function ownTicket(ticket, uid) { return ticket && String(ticket.user_id) === String(uid); }
function addAudit(action, actor, target, extra = {}) {
  const db = store.get();
  if (!Array.isArray(db.audit)) db.audit = [];
  db.audit.push({ action, actor_id: String(actor), target_id: String(target), extra, at: new Date().toISOString() });
  if (db.audit.length > 1000) db.audit.splice(0, db.audit.length - 1000);
}
function validPositiveInt(n, fallback, max) { const v = Number.parseInt(n, 10); return Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback; }

function attachProxyCenter(app) {
  app.use('/static', require('express').static(publicDir, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, etag: true }));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/app', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/manifest.webmanifest', (_req, res) => res.sendFile(path.join(publicDir, 'manifest.webmanifest')));
  app.get('/health', (req, res, next) => {
    // Preserve original app health response, adding a stable project marker.
    return res.json({ ok: true, service: 'proxy-center-afg', time: new Date().toISOString(), uptime_seconds: Math.floor(process.uptime()) });
  });
  app.get('/api/public-config', (_req, res) => res.json({ ok: true, app_name: 'Proxy Center AFG', support_username: SUPPORT_USERNAME, provider_fancy: PROVIDER_FANCY, provider_name: PROVIDER_NAME, telegram_bot_configured: !!(CONFIG.BOT_TOKEN && CONFIG.BOT_TOKEN.includes(':') && CONFIG.BOT_TOKEN !== 'REPLACE_WITH_NEW_BOT_TOKEN' && CONFIG.BOT_TOKEN !== '8814745943:AAGw-S5k1pNLfeHFswCquu_CYCi-NdTixNQ'), admin_id: undefined }));

  const authenticated = [authMiddleware];
  app.get('/api/me', ...authenticated, (req, res) => res.json({ ok: true, user: { ...store.publicUser(req.currentUser), phone_number: req.currentUser.phone_number || '' }, is_admin: String(req.currentUser.id) === ADMIN_ID }));
  app.delete('/api/me/contact', ...authenticated, async (req, res) => { delete req.currentUser.phone_number; await store.save(); res.json({ ok: true }); });
  app.get('/api/users/:id', ...authenticated, (req, res) => {
    const user = getCurrentUser(cleanText(req.params.id, 32));
    if (!user) return res.status(404).json({ ok: false, error: 'کاربر پیدا نشد.' });
    res.json({ ok: true, user: { id: String(user.id), first_name: user.first_name || '', last_name: user.last_name || '', username: user.username || '', joined_at: user.joined_at, is_admin: String(user.id) === ADMIN_ID } });
  });

  app.get('/api/notifications', ...authenticated, (req, res) => {
    const uid = String(req.currentUser.id);
    const notifications = store.get().notifications.filter(n => n.target_id === uid || (uid === ADMIN_ID && n.target_id === 'admin'))
      .sort((a, b) => b.id - a.id).slice(0, 50);
    res.json({ ok: true, notifications, unread: notifications.filter(n => !n.read).length });
  });
  app.post('/api/notifications/read', ...authenticated, async (req, res) => {
    const uid = String(req.currentUser.id); const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).slice(0, 100) : [];
    for (const item of store.get().notifications) if ((item.target_id === uid || (uid === ADMIN_ID && item.target_id === 'admin')) && (!ids.length || ids.includes(item.id))) item.read = true;
    await store.save(); res.json({ ok: true });
  });

  // Telegram-like group online counter. A heartbeat is refreshed while the chat is open.
  app.post('/api/chat/presence', ...authenticated, rateLimit({ max: 20, windowMs: 60_000 }), (req, res) => {
    const uid = String(req.currentUser.id);
    const now = Date.now();
    if (req.body?.active === false) onlineUsers.delete(uid);
    else onlineUsers.set(uid, { seen: now, name: [req.currentUser.first_name, req.currentUser.last_name].filter(Boolean).join(' ').slice(0, 80) || 'کاربر' });
    for (const [id, item] of onlineUsers) if (now - item.seen > ONLINE_TTL_MS) onlineUsers.delete(id);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, online_count: onlineUsers.size, checked_at: new Date(now).toISOString(), scope: 'single-instance' });
  });
  app.get('/api/chat/presence', ...authenticated, (req, res) => {
    const now = Date.now();
    for (const [id, item] of onlineUsers) if (now - item.seen > ONLINE_TTL_MS) onlineUsers.delete(id);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, online_count: onlineUsers.size, checked_at: new Date(now).toISOString(), scope: 'single-instance' });
  });

  // Shared chat with text-only payloads, reply/edit/delete limited to the owner (or admin).
  app.get('/api/chat', ...authenticated, rateLimit({ max: 40 }), (req, res) => {
    const db = store.get();
    const messages = db.messages.slice(-120).map(messageShape);
    res.json({ ok: true, messages, count: db.messages.length });
  });
  app.post('/api/chat', ...authenticated, rateLimit({ max: 25 }), async (req, res) => {
    const text = cleanText(req.body?.text, 1500);
    if (!text) return res.status(400).json({ ok: false, error: 'متن پیام خالی است.' });
    if (text.length > 1500) return res.status(400).json({ ok: false, error: 'پیام خیلی طولانی است.' });
    const db = store.get();
    let replyTo = Number(req.body?.reply_to || 0) || null;
    if (replyTo && !db.messages.some(m => m.id === replyTo)) replyTo = null;
    const m = { id: store.next('message'), user_id: String(req.currentUser.id), name: [req.currentUser.first_name, req.currentUser.last_name].filter(Boolean).join(' '), username: req.currentUser.username || '', text, reply_to: replyTo, created_at: new Date().toISOString() };
    db.messages.push(m); if (db.messages.length > 2000) db.messages.splice(0, db.messages.length - 2000);
    await store.save();
    if (String(req.currentUser.id) !== ADMIN_ID) addMessageNotification('admin', 'chat_activity', 'پیام جدید در چت', `${m.name || 'کاربر'} پیام جدید فرستاد.`, { message_id: m.id });
    res.status(201).json({ ok: true, message: messageShape(m) });
  });
  app.put('/api/chat/:id', ...authenticated, rateLimit({ max: 30 }), async (req, res) => {
    const id = Number(req.params.id); const m = store.get().messages.find(x => x.id === id);
    if (!m) return res.status(404).json({ ok: false, error: 'پیام پیدا نشد.' });
    if (String(m.user_id) !== String(req.currentUser.id) && String(req.currentUser.id) !== ADMIN_ID) return res.status(403).json({ ok: false, error: 'فقط نویسنده پیام یا مدیر می‌تواند آن را ویرایش کند.' });
    const text = cleanText(req.body?.text, 1500); if (!text) return res.status(400).json({ ok: false, error: 'متن پیام خالی است.' });
    m.text = text; m.edited_at = new Date().toISOString(); await store.save(); res.json({ ok: true, message: messageShape(m) });
  });
  app.delete('/api/chat/:id', ...authenticated, rateLimit({ max: 20 }), async (req, res) => {
    const id = Number(req.params.id); const db = store.get(); const idx = db.messages.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'پیام پیدا نشد.' });
    const m = db.messages[idx];
    if (String(m.user_id) !== String(req.currentUser.id) && String(req.currentUser.id) !== ADMIN_ID) return res.status(403).json({ ok: false, error: 'اجازه حذف این پیام را ندارید.' });
    db.messages.splice(idx, 1); await store.save(); res.json({ ok: true });
  });

  // Support inbox and in-app notifications.
  app.get('/api/support', ...authenticated, (req, res) => {
    const tickets = store.get().tickets.filter(t => String(t.user_id) === String(req.currentUser.id)).sort((a,b) => b.id - a.id).slice(0, 30).map(ticketShape);
    res.json({ ok: true, tickets });
  });
  app.post('/api/support', ...authenticated, rateLimit({ max: 5 }), async (req, res) => {
    const subject = cleanText(req.body?.subject || 'سایر موارد', 100);
    const text = cleanText(req.body?.message, 1800);
    if (!text) return res.status(400).json({ ok: false, error: 'متن پیام را بنویسید.' });
    const now = new Date().toISOString();
    const ticket = { id: store.next('ticket'), user_id: String(req.currentUser.id), subject, status: 'open', created_at: now, updated_at: now, messages: [{ sender_id: String(req.currentUser.id), text, at: now }] };
    store.get().tickets.push(ticket); await store.save();
    addMessageNotification('admin', 'support_new', 'پیام جدید پشتیبانی', `${ticket.subject} · ${req.currentUser.first_name || 'کاربر'}`, { ticket_id: ticket.id }); await store.save();
    res.status(201).json({ ok: true, ticket: ticketShape(ticket) });
  });
  app.post('/api/support/:id/reply', ...authenticated, rateLimit({ max: 10 }), async (req, res) => {
    const ticket = store.get().tickets.find(t => t.id === Number(req.params.id));
    if (!ownTicket(ticket, req.currentUser.id)) return res.status(404).json({ ok: false, error: 'درخواست پشتیبانی پیدا نشد.' });
    const text = cleanText(req.body?.message, 1800); if (!text) return res.status(400).json({ ok: false, error: 'متن پیام خالی است.' });
    const now = new Date().toISOString(); ticket.messages.push({ sender_id: String(req.currentUser.id), text, at: now }); ticket.updated_at = now; ticket.status = 'open';
    addMessageNotification('admin', 'support_reply', 'پاسخ جدید کاربر', `درخواست شماره ${ticket.id}`, { ticket_id: ticket.id }); await store.save();
    res.json({ ok: true, ticket: ticketShape(ticket) });
  });

  app.get('/api/configs', ...authenticated, rateLimit({ max: 8 }), async (req, res) => {
    const type = req.query.type === 'telegram' ? 'telegram' : 'v2ray';
    const limit = validPositiveInt(req.query.limit, 10, 100);
    const protocol = type === 'telegram' ? 'all' : cleanText(req.query.protocol || 'all', 20).toLowerCase();
    const allowed = ['all','vless','vmess','trojan','ss','hysteria2','tuic'];
    if (!allowed.includes(protocol)) return res.status(400).json({ ok: false, error: 'پروتکل انتخاب‌شده معتبر نیست.' });
    try {
      const result = await getConfigs(type, limit, protocol);
      res.json({ ok: true, ...result });
    } catch (err) { res.status(502).json({ ok: false, error: 'دریافت منابع عمومی ناموفق بود.', detail: process.env.NODE_ENV === 'production' ? undefined : err.message }); }
  });

  // Admin routes are guarded by verified Telegram initData and numeric Telegram ID.
  const admin = [...authenticated, adminMiddleware];
  app.get('/api/admin/overview', ...admin, (req, res) => {
    const db = store.get(); const openTickets = db.tickets.filter(t => t.status === 'open').length;
    const since24 = Date.now() - 86400_000;
    res.json({ ok: true, overview: { users: db.users.length, blocked: db.users.filter(u => u.blocked).length, messages: db.messages.length, open_tickets: openTickets, new_users_24h: db.users.filter(u => Date.parse(u.joined_at || 0) > since24).length } });
  });
  app.get('/api/admin/users', ...admin, rateLimit({ max: 30 }), (req, res) => {
    const q = cleanText(req.query.q || '', 100).toLowerCase();
    const users = store.get().users.filter(u => !q || [u.id, u.username, u.first_name, u.last_name].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((a,b) => Date.parse(b.last_seen || 0) - Date.parse(a.last_seen || 0)).slice(0, 300).map(u => ({ ...store.publicUser(u), phone_number: u.phone_number || '' }));
    res.json({ ok: true, users });
  });
  app.post('/api/admin/users/:id/block', ...admin, async (req, res) => {
    const uid = String(req.params.id); if (uid === ADMIN_ID) return res.status(400).json({ ok: false, error: 'مدیر اصلی قابل مسدودسازی نیست.' });
    const user = getCurrentUser(uid); if (!user) return res.status(404).json({ ok: false, error: 'کاربر پیدا نشد.' });
    user.blocked = true; user.blocked_at = new Date().toISOString(); user.block_reason = cleanText(req.body?.reason || 'توسط مدیر', 200);
    addAudit('user_block', req.currentUser.id, uid, { reason: user.block_reason }); addMessageNotification(uid, 'account_blocked', 'دسترسی مسدود شد', 'دسترسی حساب شما توسط مدیر مسدود شده است.', {});
    await store.save(); res.json({ ok: true, user: store.publicUser(user) });
  });
  app.post('/api/admin/users/:id/unblock', ...admin, async (req, res) => {
    const uid = String(req.params.id); const user = getCurrentUser(uid);
    if (!user) return res.status(404).json({ ok: false, error: 'کاربر پیدا نشد.' });
    user.blocked = false; delete user.blocked_at; delete user.block_reason;
    addAudit('user_unblock', req.currentUser.id, uid); addMessageNotification(uid, 'account_unblocked', 'دسترسی باز شد', 'دسترسی حساب شما دوباره فعال شد.', {});
    await store.save(); res.json({ ok: true, user: store.publicUser(user) });
  });
  app.get('/api/admin/tickets', ...admin, (req, res) => {
    const tickets = store.get().tickets.slice().sort((a,b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 100).map(ticketShape);
    res.json({ ok: true, tickets });
  });
  app.post('/api/admin/tickets/:id/reply', ...admin, rateLimit({ max: 30 }), async (req, res) => {
    const ticket = store.get().tickets.find(t => t.id === Number(req.params.id));
    if (!ticket) return res.status(404).json({ ok: false, error: 'درخواست پشتیبانی پیدا نشد.' });
    const text = cleanText(req.body?.message, 1800); if (!text) return res.status(400).json({ ok: false, error: 'متن پاسخ خالی است.' });
    const now = new Date().toISOString(); ticket.messages.push({ sender_id: 'admin', text, at: now }); ticket.updated_at = now; ticket.status = 'answered';
    addMessageNotification(ticket.user_id, 'support_reply', 'پاسخ پشتیبانی', `پاسخ درخواست شماره ${ticket.id} آماده است.`, { ticket_id: ticket.id }); addAudit('ticket_reply', req.currentUser.id, ticket.user_id, { ticket_id: ticket.id });
    await store.save(); res.json({ ok: true, ticket: ticketShape(ticket) });
  });
  app.post('/api/admin/tickets/:id/close', ...admin, async (req, res) => {
    const ticket = store.get().tickets.find(t => t.id === Number(req.params.id)); if (!ticket) return res.status(404).json({ ok: false, error: 'درخواست پیدا نشد.' });
    ticket.status = 'closed'; ticket.updated_at = new Date().toISOString(); await store.save(); res.json({ ok: true });
  });
  app.post('/api/admin/broadcast', ...admin, rateLimit({ max: 3 }), async (req, res) => {
    const title = cleanText(req.body?.title, 100); const text = cleanText(req.body?.message, 1500);
    if (!title || !text) return res.status(400).json({ ok: false, error: 'عنوان و متن پیام الزامی است.' });
    const users = store.get().users.filter(u => !u.blocked && String(u.id) !== ADMIN_ID).slice(0, 5000);
    for (const u of users) addMessageNotification(u.id, 'broadcast', title, text, { from_admin: true });
    addAudit('broadcast', req.currentUser.id, 'all', { recipients: users.length, title }); await store.save();
    res.json({ ok: true, sent_to: users.length, method: 'in-app notifications' });
  });
  app.get('/api/admin/audit', ...admin, (req, res) => {
    const audit = (store.get().audit || []).slice(-100).reverse(); res.json({ ok: true, audit });
  });

  app.get('/blocked', (_req, res) => res.sendFile(path.join(publicDir, 'blocked.html')));
}
module.exports = { attachProxyCenter };
