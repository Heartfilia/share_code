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
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 单条分享上限 2MB
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
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('内容太大，单次分享上限 2MB'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
    return sendJson(res, err.status || 400, { error: err.message });
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
    return sendJson(res, 413, { error: '内容太大，单次分享上限 2MB' });
  }

  let token = newToken();
  let file = sharePath(token);
  for (let i = 0; i < 5 && fs.existsSync(file); i += 1) {
    token = newToken();
    file = sharePath(token);
  }

  fs.writeFileSync(file, content, 'utf8');
  const expiresAt = Date.now() + TTL_MS;

  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 新建分享 ${token} (${Buffer.byteLength(content, 'utf8')} 字节)`);

  return sendJson(res, 200, {
    token,
    url: `${baseUrl(req)}/s/${token}`,
    expiresAt,
    ttlMinutes: TTL_MINUTES,
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    return sendJson(res, 400, { error: '无效的请求地址' });
  }

  if (req.method === 'POST' && pathname === '/api/share') {
    return handleShare(req, res);
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
      content: share.content,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    }).replace(/</g, '\\u003c');

    return sendHtml(res, 200, readTemplate('view.html', { PAYLOAD: payload, TTL_MINUTES }));
  }

  if (req.method === 'GET' && serveIcon(res, pathname)) {
    return;
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
