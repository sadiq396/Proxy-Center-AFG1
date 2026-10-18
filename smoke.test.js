'use strict';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `proxy-center-test-${process.pid}`);
process.env.ADMIN_ID = '6891242026';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { verifyInitData, upsertTelegramUser } = require('../src/telegram');
const store = require('../src/store');
const { tcpTest, pingTest } = require('../src/configs');

function signedInitData(token, user) {
  const values = new Map([['auth_date', String(Math.floor(Date.now() / 1000))], ['query_id', 'AAE-test'], ['user', JSON.stringify(user)]]);
  const dataCheckString = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return `${[...values.entries()].map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}&hash=${hash}`;
}

test('Telegram WebApp initData verifies only with correct signature', () => {
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  const user = { id: 6891242026, first_name: 'Test', username: 'test_user' };
  const signed = signedInitData(token, user);
  assert.equal(verifyInitData(signed, token).id, user.id);
  assert.throws(() => verifyInitData(signed.replace('Test', 'Bad'), token), /امضای|اطلاعات کاربر|اعتبارسنجی/);
});

test('Telegram user upsert does not invent a phone number', () => {
  const u = upsertTelegramUser({ id: 100001, first_name: 'Example', username: 'sample' });
  assert.equal(u.id, '100001');
  assert.equal(u.phone_number, undefined);
  assert.ok(store.getUser('100001'));
});

test('TCP test refuses localhost instead of probing it', async () => {
  const result = await tcpTest('vless://id@localhost:443?encryption=none');
  assert.equal(result.status, 'blocked');
});

test('Mini App inline JavaScript parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script);
});


test('real ping refuses localhost instead of probing it', async () => {
  const result = await pingTest('vless://id@localhost:443?encryption=none');
  assert.equal(result.status, 'blocked');
});

test('mini app provides back buttons, group online badge, and platform downloads', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const marker of ['data-back', 'onlineCount', 'screen-chat', 'Hiddify for Windows', 'Hiddify for iOS', 'v2rayNG']) assert.ok(html.includes(marker), `missing ${marker}`);
  assert.ok(!html.includes('data-open-sanaei'));
  assert.ok(!html.includes('ساخت پنل سنایی / مرزبان'));
});
