#!/usr/bin/env bash
#
# 速享 · 应用侧部署脚本（Debian / Ubuntu）
#
# 用法：
#   sudo ./deploy/deploy.sh          # 首次完整部署（建用户 + 装 systemd 服务 + 复制文件）
#   sudo ./deploy/deploy.sh update   # 日常更新（只复制文件 + 重启服务）
#
# 前置条件：
#   - 已安装 Node.js 18+（node -v 能输出版本）
#   - 系统使用 systemd
#
# 本脚本只负责「应用侧」：创建系统用户、复制文件、安装并启动 systemd 服务。
# Node.js、Nginx、HTTPS 证书请按部署步骤单独安装。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/share}"
APP_USER="${APP_USER:-share}"
SERVICE_NAME="share"

# install = 首次完整部署；update = 日常更新（改完代码后同步）
MODE="${1:-install}"
case "$MODE" in
  install|update) ;;
  *) echo "未知参数：$MODE（可用：install / update）" >&2; exit 2 ;;
esac

# 脚本所在目录的上一级 = 项目根目录
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------ 前置检查 ------------------------------

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo $0"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "未找到 node，请先安装 Node.js 18+"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 版本过低（当前 $("$NODE_BIN" -v)），需要 18 及以上"

[ -f "$SRC_DIR/server.js" ] || die "未找到 $SRC_DIR/server.js，请在项目根目录内运行本脚本"

command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，本脚本仅适用于使用 systemd 的发行版"

# ---- 处理安装在家目录下的 Node ----
# nvm 装的 node 通常位于 /root/.nvm 或 /home/<用户>/.nvm 下，而 /usr/bin/node
# 往往只是指向它的软链接。服务以系统用户运行、且 systemd 屏蔽了家目录
# （ProtectHome=true），引用这类路径会报：
#   Failed to locate executable /usr/bin/node: No such file or directory
# 因此复制一份真实二进制到 /usr/local/bin 使用。
NODE_REAL="$(readlink -f "$NODE_BIN")"
case "$NODE_REAL" in
  /home/*|/root/*)
    warn "检测到 Node 实际位于家目录：$NODE_REAL"
    warn "服务运行时无法访问家目录，正在复制一份到 /usr/local/bin/node"
    [ -e /usr/local/bin/node ] && warn "已存在 /usr/local/bin/node，将被覆盖"
    install -o root -g root -m 755 "$NODE_REAL" /usr/local/bin/node
    NODE_BIN="/usr/local/bin/node"
    "$NODE_BIN" -v >/dev/null 2>&1 || die "复制后的 node 无法执行：$NODE_BIN"
    log "已改用系统目录下的副本：$NODE_BIN（$("$NODE_BIN" -v)）"
    ;;
esac

log "Node 路径：$NODE_BIN（$("$NODE_BIN" -v)）"
log "源目录：$SRC_DIR"
log "安装到：$APP_DIR"

# ------------------------------ 创建用户 ------------------------------

if [ "$MODE" = "install" ]; then
  if id "$APP_USER" >/dev/null 2>&1; then
    log "系统用户 $APP_USER 已存在，跳过创建"
  else
    log "创建系统用户 $APP_USER（无登录权限）"
    useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$APP_USER"
  fi
else
  id "$APP_USER" >/dev/null 2>&1 || die "系统用户 $APP_USER 不存在，请先执行完整部署：sudo $0 install"
fi

# ------------------------------ 复制文件 ------------------------------

log "创建目录 $APP_DIR"
mkdir -p "$APP_DIR/public" "$APP_DIR/shares"

if [ "$SRC_DIR" = "$APP_DIR" ]; then
  # 已经就地运行（例如直接用 rsync 同步到了 $APP_DIR），无需再复制
  log "源目录与目标目录相同，跳过文件复制（就地部署）"
  chown "$APP_USER:$APP_USER" "$APP_DIR/server.js" "$APP_DIR/cleanup.js" 2>/dev/null || true
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/public" 2>/dev/null || true
else
  # 只覆盖程序文件，保留 shares/ 里尚未过期的分享
  log "复制应用文件"
  install -o "$APP_USER" -g "$APP_USER" -m 644 "$SRC_DIR/server.js"  "$APP_DIR/server.js"
  install -o "$APP_USER" -g "$APP_USER" -m 644 "$SRC_DIR/cleanup.js" "$APP_DIR/cleanup.js"
  # public/ 下的全部文件都要复制（含 favicon.svg / favicon.ico 等静态资源）
  for f in "$SRC_DIR"/public/*; do
    [ -f "$f" ] || continue
    install -o "$APP_USER" -g "$APP_USER" -m 644 "$f" "$APP_DIR/public/$(basename "$f")"
  done
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR/shares"
chmod 750 "$APP_DIR/shares"

log "文件已就位："
find "$APP_DIR" -maxdepth 2 -not -path "$APP_DIR/shares/*" -printf '    %M %u:%g  %p\n' | sort

for f in server.js cleanup.js public/index.html public/view.html public/expired.html; do
  [ -f "$APP_DIR/$f" ] || die "缺少文件：$APP_DIR/$f"
done
for f in public/favicon.svg public/favicon.ico; do
  [ -f "$APP_DIR/$f" ] || warn "缺少站点图标：$APP_DIR/$f（页面仍可用，只是标签页没有图标）"
done

# ---------------------------- 安装 systemd ----------------------------

if [ "$MODE" = "install" ]; then
  log "安装 systemd 单元 /etc/systemd/system/${SERVICE_NAME}.service"

  sed -e "s|^User=.*|User=$APP_USER|" \
      -e "s|^Group=.*|Group=$APP_USER|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
      -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $APP_DIR/server.js|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=$APP_DIR/shares|" \
      "$SRC_DIR/deploy/share.service" > "/etc/systemd/system/${SERVICE_NAME}.service"

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
else
  log "update 模式：保留现有 systemd 单元，不重新生成"
fi

log "重启服务"
systemctl restart "$SERVICE_NAME"

sleep 1
if systemctl is-active --quiet "$SERVICE_NAME"; then
  log "服务已启动"
else
  warn "服务启动失败，最近日志如下："
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
  exit 1
fi

# -------------------------------- 自检 --------------------------------

PORT="$(grep -oP '^Environment=PORT=\K\d+' "/etc/systemd/system/${SERVICE_NAME}.service" || echo 3000)"
if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/"; then
  log "本机自检通过：http://127.0.0.1:${PORT}/ 返回 200"
else
  warn "本机自检失败，请查看：journalctl -u $SERVICE_NAME -n 50"
fi

if [ "$MODE" = "install" ]; then
  cat <<EOF

────────────────────────────────────────────────
 应用侧部署完成（首次安装）

   服务状态：  systemctl status $SERVICE_NAME
   实时日志：  journalctl -u $SERVICE_NAME -f
   重启服务：  systemctl restart $SERVICE_NAME
   更新代码：  sudo $0 update

 还需完成：
   1. 配置 Nginx 反向代理
      deploy/nginx.conf  →  /etc/nginx/conf.d/share.conf
   2. 申请 HTTPS 证书
      sudo certbot --nginx -d 你的域名
   3. 放行防火墙 80 / 443（3000 端口不要对外开放）
   4. 想固定分享链接前缀，编辑
      /etc/systemd/system/${SERVICE_NAME}.service
      解开 PUBLIC_BASE_URL 那行并填入你的域名，然后
      systemctl daemon-reload && systemctl restart $SERVICE_NAME
────────────────────────────────────────────────
EOF
else
  cat <<EOF

────────────────────────────────────────────────
 代码已更新（update 模式）

   服务状态：  systemctl status $SERVICE_NAME
   实时日志：  journalctl -u $SERVICE_NAME -f
   查看文件：  ls -la $APP_DIR $APP_DIR/public

 注意：本次只更新了程序文件，未改动用户与 systemd 配置。
       浏览器可能缓存了旧图标，验证时建议用无痕窗口。
────────────────────────────────────────────────
EOF
fi
