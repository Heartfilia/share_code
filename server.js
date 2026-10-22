'use strict';

/**
 * 速享 · 粘贴即分享
 *
 *   GET  /                → 分享页（大输入框 + 分享按钮）
 *   POST /api/share       → { content } → { token, url, expiresAt }
 *   GET  /s/:token        → 内容展示页；文件不存在或已过期 → 失效提示页
 *
 * 存储：shares/<token>.txt（文件名 = token，内容 = 分享内容，mtime = 创建时间）
 * 过期：默认 60 分钟，服务内每分钟自动清理一次，也可单独跑 `node cleanup.js`
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { cleanExpired, TTL_MS, TTL_MINUTES, SHARES_DIR } = require('./cleanup');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_MB = 10;
const MAX_BODY_BYTES = MAX_BODY_MB * 1024 * 1024; // 单条内容上限
// 请求体上限留出余量：JSON 包装与转义会让请求体比内容本身更大，
// 否则内容正好 10MB 时会因多出的 {"content":"…"} 而被误拒。
const MAX_REQUEST_BYTES = MAX_BODY_BYTES * 2;
const MAX_BODY_HINT = `文本过大，服务器资源限制只能上传小于等于 ${MAX_BODY_MB}M 的文本`;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const CLEAN_INTERVAL_MS = 60 * 1000;

// 图标文件白名单：路径写死，不与用户输入拼接，无路径穿越风险
const ICON_FILES = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
};

// 部署时显式指定分享链接前缀，如 https://share.example.com（结尾斜杠会被去掉）
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

fs.mkdirSync(SHARES_DIR, { recursive: true });

/* ---------------------------------- 工具 ---------------------------------- */

function newToken() {
  return crypto.randomBytes(12).toString('base64url'); // 16 字符，96 bit 熵
}

/** token → 磁盘路径，非法 token 一律拒绝（防路径穿越） */
function sharePath(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const file = path.join(SHARES_DIR, `${token}.txt`);
  if (path.dirname(path.resolve(file)) !== path.resolve(SHARES_DIR)) return null;
  return file;
}

/**
 * 移除凭证：分享创建时随机生成，只回给创建者，服务器另存一份。
 * 24 字节 base64url（32 字符，192 bit 熵），猜不出来。
 */
function newSec() {
  return crypto.randomBytes(24).toString('base64url');
}

/** token → 凭证文件路径，与内容文件同目录，同样过 token 校验防路径穿越 */
function metaPath(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const file = path.join(SHARES_DIR, `${token}.sec`);
  if (path.dirname(path.resolve(file)) !== path.resolve(SHARES_DIR)) return null;
  return file;
}

/** 定长比较，避免通过响应时间猜凭证 */
function secMatches(given, stored) {
  if (typeof given !== 'string' || !given || !stored) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------ 今日计数 ------------------------------ */

// 计数落盘在 shares/ 下，文件过期清理会跳过点开头的文件，不会被误删
const STATS_FILE = path.join(SHARES_DIR, '.stats.json');

/** 本地时区的 YYYY-MM-DD，跨天自然归零 */
function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return {
      date: typeof raw.date === 'string' ? raw.date : '',
      count: Number.isFinite(raw.count) ? raw.count : 0,
    };
  } catch {
    return { date: '', count: 0 };
  }
}

/**
 * 成功创建一条分享后调用；写失败只影响统计，不影响分享本身。
 *
 * 并发安全的前提是「单进程」：Node 单线程，本函数从读取到写回全是同步代码，
 * 中间没有 await，所以多个请求不可能交错执行，不会丢计数。
 * 先写临时文件再 rename 原子替换，避免进程在写入途中被杀留下半截文件，
 * 导致读不回来、计数被重置。
 */
function bumpTodayCount() {
  const today = todayKey();
  const stats = readStats();
  const count = stats.date === today ? stats.count + 1 : 1;
  const tmp = `${STATS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ date: today, count }), 'utf8');
    fs.renameSync(tmp, STATS_FILE); // 同分区 rename 是原子操作
  } catch { /* 忽略 */ }
  return count;
}

function todayCount() {
  const stats = readStats();
  return stats.date === todayKey() ? stats.count : 0;
}

/** 读取一份有效分享，不存在或已过期返回 null（顺手删掉过期文件） */
function readShare(token) {
  const file = sharePath(token);
  if (!file) return null;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const expiresAt = stat.mtimeMs + TTL_MS;
  if (Date.now() >= expiresAt) {
    try { fs.unlinkSync(file); } catch { /* 已被清理，忽略 */ }
    return null;
  }

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  return { content, createdAt: stat.mtimeMs, expiresAt };
}

function readTemplate(name, vars = {}) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    html = html.split(`{{${key}}}`).join(String(value));
  }
  return html;
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 提供白名单内的图标文件；返回 false 表示未处理（交给后续路由） */
function serveIcon(res, pathname) {
  const entry = ICON_FILES[pathname];
  if (!entry) return false;

  let data;
  try {
    data = fs.readFileSync(path.join(PUBLIC_DIR, entry[0]));
  } catch {
    return false; // 文件不存在，落到最后的 404
  }

  res.writeHead(200, {
    'Content-Type': entry[1],
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(data);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;

    req.on('data', (chunk) => {
      if (exceeded) return; // 已超限，后续数据直接丢弃
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        exceeded = true;
        // 这里不 destroy：先把 413 响应写出去，否则客户端只会收到连接重置，
        // 读不到提示文案。连接断开交给 handleShare 在响应完成后处理。
        reject(Object.assign(new Error(MAX_BODY_HINT), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 多级代理下取第一个值（如 "https, http" → "https"） */
function firstValue(value) {
  if (!value) return '';
  return String(value).split(',')[0].trim();
}

/**
 * 推导分享链接的前缀，优先级从高到低：
 *   1. PUBLIC_BASE_URL 环境变量 —— 部署时显式钉死域名，不依赖代理配置
 *   2. X-Forwarded-Proto / X-Forwarded-Host —— Nginx 等反向代理会带上
 *   3. Host 请求头 —— 直连时的标准行为
 *
 * 因此：用 localhost 访问就生成 localhost 链接，用局域网 IP 访问就生成 IP 链接，
 * 用域名访问就生成域名链接，无需改代码。
 */
function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  const proto = firstValue(req.headers['x-forwarded-proto']) || 'http';
  const host = firstValue(req.headers['x-forwarded-host'])
    || firstValue(req.headers.host)
    || `localhost:${PORT}`;

  return `${proto}://${host}`;
}

/* --------------------------------- 路由 ---------------------------------- */

async function handleShare(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    const status = err.status || 400;
    // 超限时请求体还没收完，等 413 响应写完后主动断开连接
    if (status === 413) res.on('finish', () => req.destroy());
    return sendJson(res, status, { error: err.message });
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }

  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!content.trim()) {
    return sendJson(res, 400, { error: '内容不能为空' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
    return sendJson(res, 413, { error: MAX_BODY_HINT });
  }

  let token = newToken();
  let file = sharePath(token);
  for (let i = 0; i < 5 && fs.existsSync(file); i += 1) {
    token = newToken();
    file = sharePath(token);
  }

  fs.writeFileSync(file, content, 'utf8');

  // 提前移除用的凭证：只返回给创建者，服务器另存一份用于日后核对
  const sec = newSec();
  fs.writeFileSync(metaPath(token), sec, 'utf8');

  // 落盘成功后才计数，失败（抛异常）不会走到这里
  bumpTodayCount();

  const expiresAt = Date.now() + TTL_MS;

  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 新建分享 ${token} (${Buffer.byteLength(content, 'utf8')} 字节)`);

  return sendJson(res, 200, {
    token,
    sec,
    url: `${baseUrl(req)}/s/${token}`,
    expiresAt,
    ttlMinutes: TTL_MINUTES,
  });
}

/**
 * 提前移除分享：POST /api/remove { token, sec }
 *
 * 必须同时给出 token 与创建时下发的 sec，二者对得上才删。
 * 删除范围严格限定为 SHARES_DIR 内的 <token>.txt 与 <token>.sec 两个文件：
 * token 已过 TOKEN_RE（只含字母数字下划线短横线），再加上目录校验，
 * 任何形如 ../ 的路径都无法构造出来，也就碰不到目录外的文件。
 */
async function handleRemove(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    const status = err.status || 400;
    if (status === 413) res.on('finish', () => req.destroy());
    return sendJson(res, status, { error: err.message });
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }

  const token = typeof payload.token === 'string' ? payload.token : '';
  const sec = typeof payload.sec === 'string' ? payload.sec : '';

  const file = sharePath(token);
  const meta = metaPath(token);
  if (!file || !meta) return sendJson(res, 400, { error: '参数不合法' });

  let stored = '';
  try {
    stored = fs.readFileSync(meta, 'utf8').trim();
  } catch {
    return sendJson(res, 404, { error: '链接不存在或已失效' });
  }

  if (!secMatches(sec, stored)) {
    return sendJson(res, 403, { error: '无权移除这条分享' });
  }

  // 只删自己算出来的这两个路径，绝不接受请求里的路径
  try { fs.unlinkSync(file); } catch { /* 内容可能已被清理 */ }
  try { fs.unlinkSync(meta); } catch { /* 同上 */ }

  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 提前移除 ${token}`);

  return sendJson(res, 200, { ok: true });
}

/**
 * 原始内容 API：GET /source/<token>
 *
 * 与展示页 /s/<token> 对应，但返回纯文本原文而非 HTML 页面，
 * 供外部工具（JSON 格式化等）通过 ?url= 参数直接抓取。
 * 成功返回原文；token 无效或已过期返回 {"code":-1,"msg":"内容已经过期"}。
 * 响应带 Access-Control-Allow-Origin: *，任意站点都能在浏览器端直接读取。
 */
function handleRaw(req, res, token) {
  // 跨域预检（GET 属简单请求通常不触发，这里兜底）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const share = readShare(token);

  if (!share) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ code: -1, msg: '内容已经过期' }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(share.content);
}

const server = http.createServer(async (req, res) => {
  let url, pathname;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: '无效的请求地址' });
  }

  if (req.method === 'POST' && pathname === '/api/share') {
    return handleShare(req, res);
  }

  if (req.method === 'POST' && pathname === '/api/remove') {
    return handleRemove(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, { date: todayKey(), count: todayCount() });
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendHtml(res, 200, readTemplate('index.html', { TTL_MINUTES }));
  }

  if (req.method === 'GET' && pathname.startsWith('/s/')) {
    const token = pathname.slice(3);
    const share = readShare(token);

    if (!share) {
      return sendHtml(res, 410, readTemplate('expired.html', { TTL_MINUTES }));
    }

    const payload = JSON.stringify({
      token,
      content: share.content,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    }).replace(/</g, '\\u003c');

    return sendHtml(res, 200, readTemplate('view.html', { PAYLOAD: payload, TTL_MINUTES }));
  }

  if (req.method === 'GET' && serveIcon(res, pathname)) {
    return;
  }

  // 原始内容 API：/source/<token>
  // 与展示页 /s/<token> 对应，但返回纯文本原文而非 HTML 页面。
  if ((req.method === 'GET' || req.method === 'OPTIONS') && pathname.startsWith('/source/')) {
    return handleRaw(req, res, pathname.slice('/source/'.length));
  }

  return sendJson(res, 404, { error: '页面不存在' });
});

/* -------------------------------- 启动 ----------------------------------- */

server.listen(PORT, HOST, () => {
  const removed = cleanExpired();
  console.log('──────────────────────────────────────────────');
  console.log('  速享 · 粘贴即分享 已启动');
  console.log(`  本机访问：http://localhost:${PORT}`);
  console.log(`  存储目录：${SHARES_DIR}`);
  console.log(`  有效期：${TTL_MINUTES} 分钟（每分钟自动清理过期文件）`);
  console.log(`  链接前缀：${PUBLIC_BASE_URL || '自动跟随访问时的域名 / Host 头'}`);
  if (removed.removed.length) console.log(`  启动清理：删除 ${removed.removed.length} 个过期分享`);
  console.log('──────────────────────────────────────────────');
});

setInterval(() => {
  const r = cleanExpired();
  if (r.removed.length) {
    console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 自动清理 ${r.removed.length} 个过期分享`);
  }
}, CLEAN_INTERVAL_MS).unref();

process.on('SIGINT', () => {
  console.log('\n已停止服务。');
  process.exit(0);
});
