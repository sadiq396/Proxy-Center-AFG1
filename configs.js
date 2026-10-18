'use strict';
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const REPOS = [
  '0xRadikal/Free-v2ray-Configs',
  'ebrasha/free-v2ray-public-list',
];
const CHANNELS = ['TProxyRU', 'proxymtprotoir', 'ProxySeven1', 'ProxyMTProto'];
const LINK_RE = /(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic|socks|socks5|http|https|tg):\/\/[^\s\"'<>`]+/gi;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const caches = new Map();

function decodeEntities(s) { return String(s).replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function normalizeUri(s) { return decodeEntities(s.trim()).replace(/[),.;\]}]+$/g, ''); }
function protocolOf(link) {
  const p = link.split('://')[0].toLowerCase();
  if (p === 'tg' || (p === 'https' && /t\.me\/proxy\?/i.test(link))) return 'telegram';
  if (p === 'vless' || p === 'vmess' || p === 'trojan' || p === 'ss') return p;
  if (p === 'hy2') return 'hysteria2';
  if (p === 'hysteria2' || p === 'tuic') return p;
  if (p === 'socks' || p === 'socks5' || p === 'http') return 'other';
  return 'unknown';
}
function collectLinks(content) {
  const text = String(content || '').slice(0, MAX_TEXT_BYTES);
  const found = text.match(LINK_RE) || [];
  let links = found.map(normalizeUri).filter(Boolean);
  if (!links.length && /^[A-Za-z0-9+/=\r\n]+$/.test(text.trim()) && text.trim().length > 80) {
    try {
      const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
      if (decoded.includes('://')) links = (decoded.match(LINK_RE) || []).map(normalizeUri).filter(Boolean);
    } catch { /* not base64 */ }
  }
  return links;
}
async function fetchText(url, timeout = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'ProxyCenterAFG/1.0', accept: 'text/plain,application/json,text/html,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_TEXT_BYTES) throw new Error('source too large');
  const text = await res.text();
  return text.slice(0, MAX_TEXT_BYTES);
}
async function listRepoFiles(repo) {
  const headers = { 'user-agent': 'ProxyCenterAFG/1.0', accept: 'application/vnd.github+json' };
  const meta = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(7000) });
  if (!meta.ok) throw new Error(`${repo}: GitHub HTTP ${meta.status}`);
  const m = await meta.json();
  const branch = encodeURIComponent(m.default_branch || 'main');
  const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, { headers, signal: AbortSignal.timeout(9000) });
  if (!treeRes.ok) throw new Error(`${repo}: tree HTTP ${treeRes.status}`);
  const data = await treeRes.json();
  const blobs = (data.tree || []).filter(item => item.type === 'blob' && /\.(txt|json|yaml|yml|conf|md|list)$/i.test(item.path));
  const ranked = blobs.map(item => {
    const path = item.path.toLowerCase();
    let score = 0;
    if (/(all|free|config|proxy|vless|vmess|trojan|subscribe|subscription|list)/.test(path)) score += 3;
    if (/(readme|\.md$)/.test(path)) score -= 2;
    if (/(\.txt$|\.list$|\.conf$)/.test(path)) score += 2;
    if (/(test|example|sample|workflow|node_modules|\.github)/.test(path)) score -= 5;
    return { path: item.path, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  return ranked.map(x => `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(m.default_branch || 'main')}/${x.path.split('/').map(encodeURIComponent).join('/')}`);
}
async function fetchGithubConfigs() {
  const cached = caches.get('v2ray');
  if (cached && Date.now() - cached.at < 90_000) return cached.value;
  const items = [], errors = [];
  for (const repo of REPOS) {
    try {
      const files = await listRepoFiles(repo);
      for (const url of files) {
        try {
          const text = await fetchText(url, 7000);
          for (const link of collectLinks(text)) items.push({ link, protocol: protocolOf(link), source: repo, source_url: url });
        } catch (err) { errors.push(`${repo}: ${err.message}`); }
      }
    } catch (err) { errors.push(err.message); }
  }
  const seen = new Set();
  const unique = items.filter(x => {
    if (!['vless','vmess','trojan','ss','hysteria2','tuic'].includes(x.protocol)) return false;
    const key = x.link.replace(/#.*$/, '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const result = { items: unique, errors, checked_at: new Date().toISOString() };
  caches.set('v2ray', { at: Date.now(), value: result });
  return result;
}
async function fetchTelegramProxies() {
  const cached = caches.get('telegram');
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const items = [], errors = [];
  await Promise.all(CHANNELS.map(async channel => {
    try {
      const html = await fetchText(`https://t.me/s/${channel}`, 7000);
      const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => decodeEntities(m[1]));
      for (const href of hrefs) {
        if (/^https?:\/\/t\.me\/proxy\?/i.test(href) || /^tg:\/\/proxy\?/i.test(href)) {
          items.push({ link: href, protocol: 'telegram', source: `t.me/${channel}`, source_url: `https://t.me/s/${channel}` });
        }
      }
      for (const link of collectLinks(html)) if (/^tg:\/\/proxy\?/i.test(link) || /^https?:\/\/t\.me\/proxy\?/i.test(link)) items.push({ link, protocol: 'telegram', source: `t.me/${channel}`, source_url: `https://t.me/s/${channel}` });
    } catch (err) { errors.push(`${channel}: ${err.message}`); }
  }));
  const seen = new Set();
  const unique = items.filter(x => { const key = x.link.split('#')[0]; if (seen.has(key)) return false; seen.add(key); return true; });
  const result = { items: unique, errors, checked_at: new Date().toISOString() };
  caches.set('telegram', { at: Date.now(), value: result });
  return result;
}
function parseEndpoint(link) {
  try {
    if (/^vmess:\/\//i.test(link)) {
      const payload = link.slice('vmess://'.length).split('#')[0];
      const obj = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      return { host: String(obj.add || ''), port: Number(obj.port || 0) };
    }
    if (/^(tg:\/\/proxy|https?:\/\/t\.me\/proxy)\?/i.test(link)) {
      const q = link.slice(link.indexOf('?') + 1).replace(/&amp;/g, '&');
      const p = new URLSearchParams(q);
      return { host: p.get('server') || '', port: Number(p.get('port') || 0) };
    }
    if (/^ss:\/\//i.test(link)) {
      const payload = link.slice(5).split('#')[0];
      if (!payload.includes('@')) {
        let decoded = ''; try { decoded = Buffer.from(payload, 'base64').toString('utf8'); } catch {}
        const match = decoded.match(/@?(\[[^\]]+\]|[^:@\s]+):(\d{1,5})$/);
        if (match) return { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
      }
    }
    const u = new URL(link);
    return { host: u.hostname, port: Number(u.port || ((u.protocol === 'https:' || u.protocol === 'trojan:' || u.protocol === 'vless:' || u.protocol === 'vmess:') ? 443 : 80)) };
  } catch { return null; }
}
function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ip.split('.').map(Number); const [a,b] = n;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower) || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.');
  }
  return true;
}
async function tcpTest(link) {
  const endpoint = parseEndpoint(link);
  if (!endpoint || !endpoint.host || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) return { status: 'invalid', latency_ms: null, detail: 'آدرس یا پورت قابل تشخیص نیست' };
  const host = endpoint.host.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local)$/i.test(host)) return { status: 'blocked', latency_ms: null, detail: 'میزبان محلی تست نمی‌شود' };
  try {
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) return { status: 'blocked', latency_ms: null, detail: 'آدرس خصوصی یا نامعتبر است' };
    const start = Date.now();
    const address = addresses[0];
    return await new Promise(resolve => {
      let settled = false;
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
      const socket = net.connect({ host: address.address, port: endpoint.port, family: net.isIP(address.address) }, () => {
        const latency = Date.now() - start;
        socket.destroy(); finish({ status: 'tcp-open', latency_ms: latency, detail: 'اتصال TCP برقرار شد؛ عملکرد کامل تونل تأیید نشده است' });
      });
      const timer = setTimeout(() => { socket.destroy(); finish({ status: 'timeout', latency_ms: null, detail: 'مهلت اتصال تمام شد' }); }, 3000);
      socket.on('error', err => finish({ status: 'tcp-closed', latency_ms: null, detail: err.code === 'ECONNREFUSED' ? 'پورت پاسخ نمی‌دهد' : 'اتصال TCP برقرار نشد' }));
    });
  } catch (err) {
    return { status: 'error', latency_ms: null, detail: err.code === 'ENOTFOUND' ? 'نام میزبان پیدا نشد' : 'خطای DNS یا شبکه' };
  }
}
async function pingTest(link) {
  const endpoint = parseEndpoint(link);
  if (!endpoint || !endpoint.host || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) return { status: 'invalid', latency_ms: null, detail: 'آدرس یا پورت قابل تشخیص نیست' };
  const host = endpoint.host.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local)$/i.test(host)) return { status: 'blocked', latency_ms: null, detail: 'میزبان محلی تست نمی‌شود' };
  try {
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) return { status: 'blocked', latency_ms: null, detail: 'آدرس خصوصی یا نامعتبر است' };
    // ICMP echo against the endpoint IP. This is a real network ping, but not a full proxy tunnel test.
    const ip = addresses[0].address;
    const args = net.isIP(ip) === 6 ? ['-6', '-n', '-c', '1', '-W', '2', ip] : ['-n', '-c', '1', '-W', '2', ip];
    const { stdout, stderr } = await execFileAsync('ping', args, { timeout: 3000, windowsHide: true, maxBuffer: 32 * 1024 });
    const output = `${stdout || ''} ${stderr || ''}`;
    const match = output.match(/time[=<]([0-9.]+)\s*ms/i);
    if (match) return { status: 'icmp-ok', latency_ms: Number(match[1]), detail: 'پاسخ واقعی ICMP از IP میزبان؛ کارکرد کامل تونل تأیید نشده است' };
    return { status: 'timeout', latency_ms: null, detail: 'پاسخ ICMP دریافت نشد' };
  } catch (err) {
    const code = String(err.code || '');
    if (code === 'ENOENT' || /not found|not recognized/i.test(String(err.message || ''))) return { status: 'icmp-unavailable', latency_ms: null, detail: 'ابزار ping در هاست موجود نیست' };
    if (code === 'ETIMEDOUT' || code === '124' || /timed out/i.test(String(err.message || ''))) return { status: 'timeout', latency_ms: null, detail: 'مهلت پاسخ ICMP تمام شد یا پاسخ مسدود است' };
    return { status: 'timeout', latency_ms: null, detail: 'پاسخ ICMP دریافت نشد یا دسترسی ICMP محدود است' };
  }
}

async function pool(items, concurrency, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) { const i = index++; if (i >= items.length) return; try { items[i].test = await fn(items[i].link); } catch { items[i].test = { status: 'error', latency_ms: null, detail: 'تست ناموفق' }; } }
  }));
  return items;
}
async function getConfigs(type, limit = 10, protocol = 'all') {
  const fetched = type === 'telegram' ? await fetchTelegramProxies() : await fetchGithubConfigs();
  const filter = x => protocol === 'all' || x.protocol === protocol;
  const selected = fetched.items.filter(filter).slice(0, limit).map(item => ({ ...item }));
  await pool(selected, 8, pingTest);
  return { type, items: selected.map(x => ({ ...x, test: x.test || { status: 'not-tested', latency_ms: null, detail: 'تست انجام نشد' } })), found: selected.length, ping_ok_count: selected.filter(x => x.test?.status === 'icmp-ok').length, total_unique: fetched.items.filter(filter).length, checked_at: new Date().toISOString(), errors: fetched.errors, note: 'latency_ms پاسخ واقعی ICMP از محل سرور میزبان است؛ این تست پینگ endpoint است و کارکرد کامل تونل یا پینگ گوشی را ثابت نمی‌کند.' };
}
module.exports = { getConfigs, tcpTest, pingTest, REPOS, CHANNELS };
