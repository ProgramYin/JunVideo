# Cloudflare 前端 + 中国大陆 API 部署方案

## 目标架构

```text
用户浏览器
   │
   ▼
Cloudflare Pages 前端
https://jun-video.pages.dev/
   │ HTTPS / CORS
   ▼
国内 API 域名（例如 https://api.example.cn）
   │
   ▼
Nginx → Docker Compose → JunVideo API 容器
   │
   ├── yt-dlp + FFmpeg
   └── Supabase Transaction Pooler
```

Vercel 不再作为正式 API 入口，只保留为临时回滚或备用部署。前端与 API 通过 `VITE_API_BASE_URL` 解耦，业务代码不需要修改。

## 线上账号和地址

| 项目 | 当前值或入口 |
| --- | --- |
| GitHub | <https://github.com/ProgramYin/JunVideo> |
| Cloudflare Pages 前端 | <https://jun-video.pages.dev/> |
| Cloudflare 控制台 | <https://dash.cloudflare.com/> |
| Vercel 备用项目 | <https://vercel.com/programyins-projects/jun-video> |
| Supabase 项目 ref | `wlzeyfzzpwmysjijrxvk` |
| 国内 API 域名 | 待绑定，例如 `api.example.cn` |

密码、云主机密钥、数据库密码和 Cookie Secret 不写入仓库；请从密码管理器或对应平台环境变量中取用。

## 一、准备国内 API 主机

选择一个中国大陆云主机或容器服务，例如阿里云 ECS、腾讯云 CVM/Lighthouse、华为云 ECS 等。主机至少需要：

- Linux amd64，建议 Ubuntu 22.04/24.04 或 Debian 12。
- 2 核 4 GB 内存起步；视频下载并发较高时建议 4 核 8 GB。
- 公网 IPv4、可配置安全组、防火墙开放 TCP 80/443。
- Docker Engine 和 Docker Compose Plugin。
- 已完成域名备案及云厂商要求的 ICP/网站合规配置（如果使用中国大陆节点对公网提供服务）。

不要把数据库 5432、API 容器 8080 或 SSH 端口暴露给所有公网来源；API 容器只监听 `127.0.0.1:8080`，由 Nginx 提供 HTTPS。

服务器安装 Docker 示例：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo apt-get update
sudo apt-get install -y docker-compose-plugin nginx certbot python3-certbot-nginx
docker compose version
```

## 二、准备 API 域名

1. 在 DNS 服务商添加 `A` 记录，例如：

   ```text
   api.example.cn  →  国内 API 主机公网 IPv4
   ```

2. 等待 DNS 生效。
3. 将 `deploy/nginx/junvideo-api.conf` 中的 `api.example.cn` 替换成实际域名。
4. 申请 HTTPS 证书；Cloudflare Pages 调用 API 时必须使用 HTTPS。

## 三、上传并启动 API

在服务器执行：

```bash
git clone https://github.com/ProgramYin/JunVideo.git
cd JunVideo
cp .env.domestic-api.example .env.domestic-api
chmod 600 .env.domestic-api
```

编辑 `.env.domestic-api`，至少填写：

```text
DATABASE_URL=<Supabase Transaction Pooler 连接串>
DATABASE_SSL=true
DATABASE_POOL_MAX=10
JWT_SECRET=<至少 32 个字符的随机值>
CORS_ORIGIN=https://jun-video.pages.dev
```

不要把 `.env.domestic-api` 提交到 Git；它已经被 `.gitignore` 和 `.dockerignore` 排除。

### 初始化数据库

在有 Supabase CLI 的安全环境中执行一次：

```powershell
npx supabase login
npx supabase link --project-ref wlzeyfzzpwmysjijrxvk
npx supabase db push
```

### 配置授权 Cookie

在本地从已授权浏览器导出 Netscape 格式 Cookie，然后执行：

```powershell
node scripts/encrypt-ytdlp-cookies.mjs D:\private\douyin-cookies.txt
```

把输出的两行写入服务器的 `.env.domestic-api`：

```text
YTDLP_COOKIES_ENCRYPTION_KEY=<脚本输出的 key>
YTDLP_COOKIES_ENCRYPTED=jv1.<iv>.<auth-tag>.<ciphertext>
```

两项必须同时设置。不要通过 Git、聊天或公开工单传递这两项内容。

### 启动容器

```bash
docker compose -f docker-compose.domestic.yml up -d --build
docker compose -f docker-compose.domestic.yml ps
docker compose -f docker-compose.domestic.yml logs --tail=100 junvideo-api
```

容器内部健康检查：

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

## 四、配置 Nginx 和 HTTPS

复制配置并替换域名（下面示例使用 `api.example.cn`）：

```bash
sudo cp deploy/nginx/junvideo-api.conf /etc/nginx/sites-available/junvideo-api
export API_DOMAIN=api.example.cn
sudo sed -i "s/api\\.example\\.cn/${API_DOMAIN}/g" /etc/nginx/sites-available/junvideo-api
sudo ln -s /etc/nginx/sites-available/junvideo-api /etc/nginx/sites-enabled/junvideo-api
sudo nginx -t
sudo systemctl reload nginx
```

申请证书：

```bash
sudo certbot --nginx -d api.example.cn
sudo nginx -t
sudo systemctl reload nginx
```

把命令中的 `api.example.cn` 替换成实际 API 域名。之后验证：

```bash
curl -fsS https://api.example.cn/api/health
```

## 五、切换 Cloudflare Pages 前端

在 Cloudflare Pages 项目 `junvideo` 的构建环境变量中设置：

```text
VITE_API_BASE_URL=https://api.example.cn/api
```

构建配置：

```text
Build command: npm run build
Output directory: dist/client
Production branch: main
```

保存并重新部署。使用 Wrangler 手动部署时：

```powershell
npx wrangler login
$env:VITE_API_BASE_URL="https://api.example.cn/api"
npm ci
npm run build
npx wrangler pages deploy dist/client --project-name junvideo
```

国内 API 的 `CORS_ORIGIN` 必须保持：

```text
CORS_ORIGIN=https://jun-video.pages.dev
```

如果以后绑定 Cloudflare 自定义域名，还要把该自定义域名追加到 `CORS_ORIGIN`，逗号分隔。

## 六、发布后验收

### API

```powershell
Invoke-RestMethod https://api.example.cn/api/health | ConvertTo-Json -Compress
```

确认：

- `ok` 为 `true`。
- `database.status` 为 `up`。
- `parser.available` 为 `true`。
- 配置授权 Cookie 后，`features.authorizedSession` 为 `true`。

### 前端

1. 打开 <https://jun-video.pages.dev/>。
2. 使用 JunVideo 注册账号登录。
3. 解析 YouTube、Bilibili 和抖音公开链接。
4. 检查视频、音频和字幕下载。
5. 在浏览器网络请求中确认请求目标为 `api.example.cn`，不再是 `jun-video.vercel.app`。

### 服务器安全

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw delete allow 8080/tcp 2>/dev/null || true
docker compose -f docker-compose.domestic.yml ps
```

## 七、日常更新

```bash
cd /opt/JunVideo
git pull origin main
docker compose -f docker-compose.domestic.yml up -d --build
docker image prune -f
```

更新 Cookie 时只修改服务器 `.env.domestic-api`，然后重启 API：

```bash
docker compose -f docker-compose.domestic.yml up -d --force-recreate junvideo-api
```

## 八、可选的 GitHub Actions 自动发布

仓库包含 `.github/workflows/deploy-domestic-api.yml`，默认只允许手动触发，不会因为当前没有国内主机而自动失败。

在 GitHub 仓库的 `Settings → Environments` 中创建环境 `domestic-api-production`，添加以下 Secrets：

```text
DOMESTIC_API_HOST        # 国内 API 主机公网 IP 或 SSH 主机名
DOMESTIC_API_SSH_PORT    # 可选，默认 22
DOMESTIC_API_SSH_USER
DOMESTIC_API_SSH_KEY     # 专用部署私钥，不要使用个人主密钥
DOMESTIC_API_KNOWN_HOSTS # ssh-keyscan 得到的固定主机指纹
DOMESTIC_API_PATH        # 服务器上的 JunVideo 路径，例如 /opt/JunVideo
```

在同一个 Environment 中添加 Variable：

```text
DOMESTIC_API_HEALTH_URL=https://api.example.cn/api/health
```

服务器需要提前完成第三节和第四节，且部署用户能够执行 Docker Compose。之后打开 GitHub 的 `Actions → Deploy domestic API → Run workflow`，流程会拉取 `main`、重建容器并检查健康接口。

## 九、回滚

如果国内 API 部署异常：

1. Cloudflare Pages 暂时将 `VITE_API_BASE_URL` 改回 `https://jun-video.vercel.app/api`。
2. 重新部署 Cloudflare Pages。
3. 保留国内服务器日志，修复后再切回国内 API 域名。

回滚只影响前端 API 指向，不会删除数据库数据。
