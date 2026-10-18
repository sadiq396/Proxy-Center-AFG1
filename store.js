'use strict';
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dbPath = path.join(dataDir, 'store.json');
const empty = () => ({ users: [], messages: [], tickets: [], notifications: [], counters: { message: 1, ticket: 1, notification: 1 } });
let state = empty();
let writeQueue = Promise.resolve();

function normalize(input) {
  const base = empty();
  if (!input || typeof input !== 'object') return base;
  for (const key of ['users', 'messages', 'tickets', 'notifications']) base[key] = Array.isArray(input[key]) ? input[key] : [];
  base.counters = { ...base.counters, ...(input.counters || {}) };
  return base;
}
function init() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { state = normalize(JSON.parse(fs.readFileSync(dbPath, 'utf8'))); }
  catch (err) {
    if (err.code !== 'ENOENT') console.error('[db] Could not parse store.json; starting empty:', err.message);
    state = empty();
    fs.writeFileSync(dbPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
function save() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tmp = `${dbPath}.tmp`;
    await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.promises.rename(tmp, dbPath);
  }).catch(err => console.error('[db] save failed:', err.message));
  return writeQueue;
}
function get() { return state; }
function next(kind) {
  if (!state.counters[kind]) state.counters[kind] = 1;
  return state.counters[kind]++;
}
function getUser(id) { return state.users.find(u => String(u.id) === String(id)); }
function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user.id), first_name: user.first_name || '', last_name: user.last_name || '',
    username: user.username || '', language_code: user.language_code || '',
    joined_at: user.joined_at, last_seen: user.last_seen, blocked: !!user.blocked,
    has_phone_number: !!user.phone_number,
  };
}
function addNotification(targetId, type, title, body, metadata = {}) {
  const item = { id: next('notification'), target_id: String(targetId), type, title, body, metadata, read: false, created_at: new Date().toISOString() };
  state.notifications.push(item);
  if (state.notifications.length > 3000) state.notifications.splice(0, state.notifications.length - 3000);
  return item;
}
init();
module.exports = { init, save, get, next, getUser, publicUser, addNotification };
