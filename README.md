# 速享 · 粘贴即分享

把内容丢进输入框，点一下，得到一条 **1 小时后自动消失**的链接。

零依赖，纯 Node.js 内置模块实现，单进程即可运行。

---

## 它解决什么问题

临时给同事发一段配置、一串日志、一个临时口令——用聊天工具会留在历史记录里，用网盘又太重。

速享的做法是：**粘贴 → 分享 → 链接发出去**。1 小时后链接失效，内容同时从服务器磁盘上删除。

- 访问者打开链接直接看到内容，**无需登录、无需注册**
- 倒计时从**内容创建那一刻**起算，与谁在何时打开链接无关
- 内容以纯文本渲染，贴 `<script>` 也只会原样显示，天然免疫 XSS

## 特性

| 特性 | 说明 |
|---|---|
| **零依赖** | 只用 Node 内置模块，没有 `node_modules`，连 `npm install` 都不需要 |
| **1 小时自动销毁** | 服务内每分钟清理一次，访问时也会惰性删除过期文件 |
| **一键复制** | 内容页可一键复制全文，http 访问时自动降级到 `execCommand` |
| **进度条** | 内容页顶部显示剩余时间进度，10 分钟内转橙、2 分钟内转红 |
| **随机 token** | 96 bit 熵，防枚举；路径穿越攻击已被拦截 |
| **部署简单** | 附 systemd 单元与 Nginx 配置，一条命令完成应用侧部署 |

## 快速开始

需要 **Node.js 18+**。

```bash
git clone git@github.com:Heartfilia/share_code.git
cd share_code
node server.js
```

打开 <http://localhost:3000> 即可。

调整有效期和端口：

```bash
SHARE_TTL_MINUTES=10 PORT=8080 node server.js
```

## 部署到 Linux 服务器

### 架构

```
浏览器 ──HTTPS(443)──> Nginx ──HTTP(127.0.0.1:3000)──> Node 服务
```

Node 只监听本地回环地址，不直接暴露公网，外部访问一律经 Nginx 转发。

### 步骤

**1. 安装 Node.js**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

> 若用 nvm 装的 Node，注意它的实际路径可能在家目录（如 `/root/.nvm/...`），systemd 服务会因权限无法执行。`deploy.sh` 会自动检测并把二进制复制到 `/usr/local/bin`。

**2. 上传项目**

```bash
# 排除规则直接复用 .gitignore：分享数据、系统文件、编辑器配置等都不会上传
rsync -avc --exclude-from=.gitignore ./ root@你的服务器:/opt/share/
```

**3. 运行部署脚本**

```bash
cd /opt/share && sudo ./deploy/deploy.sh
```

脚本会创建 `share` 系统用户、设置目录权限、安装并启动 systemd 服务，最后做一次本机自检。

**4. 配置 Nginx**

```bash
sudo apt install -y nginx
sudo cp /opt/share/deploy/nginx.conf /etc/nginx/conf.d/share.conf
sudo vim /etc/nginx/conf.d/share.conf      # 把 share.example.com 改成你的域名
sudo nginx -t && sudo systemctl reload nginx
```

**5. 申请 HTTPS 证书**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

**6. 放行防火墙**

```bash
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

3000 端口**不要**对外开放，只留 80 / 443。

### 更新代码

```bash
# 本地：排除规则复用 .gitignore，线上分享数据不会被覆盖
rsync -avc --exclude-from=.gitignore ./ root@你的服务器:/opt/share/

# 服务器：改了 server.js 才需要重启；只改 HTML 的话刷新即可
sudo systemctl restart share
```

`-c` 让 rsync 按内容校验和比较而非时间戳，能确保有差异的文件一定传上去。

### 运维命令

```bash
systemctl status share      # 查看状态
journalctl -u share -f      # 实时日志
systemctl restart share     # 重启服务
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，反向代理场景建议设为 `127.0.0.1` |
| `SHARE_TTL_MINUTES` | `60` | 分享有效期（分钟） |
| `PUBLIC_BASE_URL` | 空 | 分享链接前缀，如 `https://share.example.com`。设置后固定使用该前缀 |
| `SHARES_DIR` | `./shares` | 内容存储目录 |

### 分享链接的生成规则

链接格式为 `<协议>://<域名>/s/<token>`，前缀按以下优先级推导：

1. `PUBLIC_BASE_URL` 环境变量
2. `X-Forwarded-Proto` / `X-Forwarded-Host` 请求头（反向代理场景）
3. `Host` 请求头

所以用域名访问就生成域名链接，用 IP 访问就生成 IP 链接，无需改代码。

> ⚠️ 反向代理时**务必转发原始 Host**（`nginx.conf` 里已配好），否则 Node 看到的是 `127.0.0.1:3000`，生成的链接会变成内网地址，发给别人打不开。

## API

### 创建分享

```http
POST /api/share
Content-Type: application/json

{ "content": "要分享的内容" }
```

响应：

```json
{
  "token": "aB3xK9mPq2Lw7YtR",
  "url": "https://share.example.com/s/aB3xK9mPq2Lw7YtR",
  "expiresAt": 1792118378394,
  "ttlMinutes": 60
}
```

### 获取原始内容

```http
GET /data?token=aB3xK9mPq2Lw7YtR
```

| 情况 | 响应 |
|---|---|
| 内容有效 | **纯文本原文**，`Content-Type: text/plain; charset=utf-8` |
| 已过期 / token 无效 | `{"code":-1,"msg":"内容已经过期"}` |

响应带 `Access-Control-Allow-Origin: *`，任意站点都可以在浏览器端直接读取，方便接入第三方工具。内容若是 JSON，调用方拿到的是未经包装的原始 JSON，可直接 `JSON.parse`。

内容页右上角的「JSON 格式化」入口就是通过这个接口把原文传给格式化工具的：

```
https://json.litetools.top?url=https://share.example.com/data?token=aB3xK9mPq2Lw7YtR
```

## 目录结构

```
server.js             主服务：路由、token 生成、过期判定
cleanup.js            过期文件清理（可独立运行，也被服务复用）
public/
  index.html          分享页
  view.html           内容展示页
  expired.html        失效提示页
  favicon.svg / .ico  站点图标
deploy/
  share.service       systemd 单元
  nginx.conf          Nginx 站点配置
  deploy.sh           部署脚本
shares/               内容存储目录（运行时自动创建，文件名即 token）
```

## 工作原理

1. 点分享 → 服务端生成 16 字符随机 token，把内容写入 `shares/<token>.txt`
2. 访问 `/s/<token>` → 读取文件并渲染；文件不存在或已过期则返回 **410** 并显示失效页
3. **过期判定 = 文件 mtime + TTL**。用文件系统时间戳而非在文件里存时间，所以文件内容就是纯正文，零额外开销
4. 服务内每分钟清理一次过期文件；访问时也会顺手删除已过期的

内容以纯文本存储和渲染，不解析 Markdown 或 HTML。

清理脚本也可以单独使用：

```bash
node cleanup.js            # 单次清理
node cleanup.js --watch    # 常驻，每分钟清理一次
```

## 安全说明

- ⚠️ **内容在服务器上以明文存储**。任何能访问服务器文件系统的人都能直接读取 `shares/` 目录。**不要用它分享密码、密钥等敏感信息。**
- token 由 `crypto.randomBytes(12)` 生成，16 字符 base64url，96 bit 熵
- 访问时校验 token 字符集并做路径规范化，防路径穿越
- 单条内容上限 2 MB，Nginx 侧需相应调大 `client_max_body_size`（配置里已设 4m）

## 许可证

[PolyForm Noncommercial License 1.0.0](LICENSE) —— 允许个人使用、研究、学习等**非商业用途**，禁止商业使用。

> 注意：这是 **source-available** 协议，**不是 OSI 定义的开源协议**——开源定义明确不允许限制使用领域。
