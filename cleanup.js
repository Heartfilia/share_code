'use strict';

/**
 * 过期分享清理脚本
 *
 * 规则：shares/ 目录下的每个文件，文件名 = token，内容 = 分享内容。
 *      文件「最后修改时间」即创建时间，超过 TTL（默认 60 分钟）即视为过期并删除。
 *
 * 用法：
 *   node cleanup.js            # 单次清理
 *   node cleanup.js --watch    # 常驻，每分钟清理一次
 *   SHARE_TTL_MINUTES=10 node cleanup.js   # 自定义有效期（分钟）
 */

const fs = require('fs');
const path = require('path');

const TTL_MINUTES = Number(process.env.SHARE_TTL_MINUTES) > 0
  ? Number(process.env.SHARE_TTL_MINUTES)
  : 60;

const TTL_MS = TTL_MINUTES * 60 * 1000;
const SHARES_DIR = process.env.SHARES_DIR
  ? path.resolve(process.env.SHARES_DIR)
  : path.join(__dirname, 'shares');

/**
 * 扫描并删除所有已过期的分享文件
 * @returns {{removed: string[], kept: number, errors: string[]}}
 */
function cleanExpired(dir = SHARES_DIR, ttlMs = TTL_MS) {
  const result = { removed: [], kept: 0, errors: [] };

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return result;
    throw err;
  }

  const now = Date.now();

  for (const name of names) {
    if (name.startsWith('.')) continue;

    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // 文件在扫描过程中被删除，忽略
    }
    if (!stat.isFile()) continue;

    // 用「最后修改时间」作为创建时间基准
    const age = now - stat.mtimeMs;
    if (age >= ttlMs) {
      try {
        fs.unlinkSync(file);
        result.removed.push(name);
      } catch (err) {
        result.errors.push(`${name}: ${err.message}`);
      }
    } else {
      result.kept += 1;
    }
  }

  return result;
}

function runOnce() {
  const r = cleanExpired();
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  if (r.removed.length === 0) {
    console.log(`[${stamp}] 清理完成：无过期文件，保留 ${r.kept} 个有效分享。`);
  } else {
    console.log(`[${stamp}] 清理完成：删除 ${r.removed.length} 个过期分享，保留 ${r.kept} 个。`);
    r.removed.forEach((name) => console.log(`  - 已删除 ${name}`));
  }
  if (r.errors.length) {
    r.errors.forEach((e) => console.error(`  ! 删除失败 ${e}`));
  }
  return r;
}

if (require.main === module) {
  if (process.argv.includes('--watch')) {
    console.log(`清理守护已启动：有效期 ${TTL_MINUTES} 分钟，目录 ${SHARES_DIR}`);
    runOnce();
    setInterval(runOnce, 60 * 1000);
  } else {
    runOnce();
  }
}

module.exports = { cleanExpired, runOnce, TTL_MS, TTL_MINUTES, SHARES_DIR };
