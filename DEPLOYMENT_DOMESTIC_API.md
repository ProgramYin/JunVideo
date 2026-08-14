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

## Cloudflare 能否直接托管后端

本项目的 API 不是普通的 Pages 静态函数：它会启动 `yt-dlp`、`ffmpeg/ffprobe` 子进程，使用临时文件，并执行较长时间的视频解析和下载任务。因此，Cloudflare Pages Functions/普通 Workers 不能直接替代当前 API 容器。

Cloudflare Containers 可以运行现有 `Dockerfile.api`，但需要 Workers Paid 计划和额外的 Worker/容器配置；其运行区域是 Cloudflare 全球区域列表中的节点，并不等于中国大陆服务器，不能据此承诺大陆网络访问效果。Cloudflare China Network 还需要 Enterprise、单独的 China Network 服务、ICP 和内容审核等条件，Pages 在中国大陆也有产品可用性限制。

所以本方案仍采用：Cloudflare Pages 托管前端，国内云主机通过 Docker 托管 API。这样 `yt-dlp + FFmpeg` 与 API 在同一台国内主机内运行，Cloudflare 只负责前端，不需要把解析器拆成单独服务。

### 没有域名时：使用 Pages 同源代理

当前只有 Windows 服务器、没有 API 域名时，可以让 Pages Function 代理 `/api/*`，前端继续使用同源的 `/api`，不需要把裸 IP 写进浏览器请求，也不需要在 Windows 服务器上配置 HTTPS：

```text
浏览器 → https://jun-video.pages.dev/api/*
       → Cloudflare Pages Function
       → http://<Windows 服务器 IP>:8080/api/*
```

仓库中的 `functions/api/[[path]].ts` 已提供该代理，`public/_routes.json` 将 Function 限制在 `/api` 路径。Cloudflare Pages 项目的生产环境变量只需增加。由于 Workers/Pages 的出站 `fetch()` 不接受 IP 字面量，临时可使用 `sslip.io` 将服务器 IP 转成主机名：

```text
API_ORIGIN=http://<用短横线替换点号的 IP>.sslip.io:8080
# 例如 IP 1.2.3.4 对应 http://1-2-3-4.sslip.io:8080
```

同时不要把 `VITE_API_BASE_URL` 设成 Vercel 或裸 IP；删除该变量后，前端会使用默认的同源 `/api`。Windows API 仍需允许公网 TCP 8080，且 `.env.domestic-api` 中保持：

```text
CORS_ORIGIN=https://jun-video.pages.dev
```

这是无域名的临时上线方式，但 `sslip.io` 不是你拥有的正式域名，且会暴露服务器 IP；API 流量会经过 Pages Function，必须在发布后实测长视频下载和字幕流是否满足当前用量。正式生产仍建议绑定自己的 API 域名。

### Windows 服务器部署

Windows 主机不能直接执行本目录的 Linux Docker/Nginx 脚本。请在管理员 PowerShell 中安装 Node.js 20+、Git 和 FFmpeg（确保 `ffmpeg.exe`、`ffprobe.exe` 在 PATH 中），然后执行：

```powershell
git clone https://github.com/ProgramYin/JunVideo.git C:\JunVideo
Set-Location C:\JunVideo
Copy-Item .env.domestic-api.example .env.domestic-api
notepad .env.domestic-api
Set-ExecutionPolicy -Scope Process Bypass
& .\deploy\windows\Install-JunVideoApi.ps1
```

第一次运行只创建配置时，填好 `DATABASE_URL`、`JWT_SECRET` 后再次运行。脚本会下载 Windows 版 `yt-dlp`、编译 API、开放 TCP 8080，并注册 `JunVideo API` 开机启动任务；同时补充 `HOST=0.0.0.0`，避免 API 只监听 localhost。健康检查通过后，再在 Pages 设置 `API_ORIGIN` 并重新部署前端。

Windows 服务器上可先确认监听和本机健康检查：

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen
Invoke-WebRequest http://127.0.0.1:8080/api/health
```

两项都正常后，Cloudflare Pages 才能通过公网访问 API。

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

API 域名不是 Docker 或后端程序本身的硬性要求，但对当前线上前端是实际要求：

- 临时测试可以直接访问 `http://服务器IP:8080/api/health`，但不应把 8080 暴露到公网。
- Cloudflare Pages 是 HTTPS 页面，不能稳定调用 `http://服务器IP/api`，浏览器会按混合内容策略拦截。
- 使用 `https://服务器IP/api` 理论上需要证书的 SAN 明确包含该 IP，证书申请、续期和客户端兼容性都比域名复杂。
- 因此生产环境建议使用一个 API 子域名，例如 `api.example.cn`；不需要单独购买一套域名，已有域名增加一条 `A` 记录即可。

1. 在 DNS 服务商添加 `A` 记录，例如：

   ```text
   api.example.cn  →  国内 API 主机公网 IPv4
   ```

2. 等待 DNS 生效。
3. 将 `deploy/nginx/junvideo-api.conf` 中的 `api.example.cn` 替换成实际域名。
4. 申请 HTTPS 证书；Cloudflare Pages 调用 API 时必须使用 HTTPS。

## 三、上传并启动 API

也可以使用仓库提供的初始化脚本。它会安装 Docker/Nginx/Certbot，创建配置模板并启动 API；第一次运行如果没有 `.env.domestic-api`，脚本只创建模板并安全退出，不会用占位 Secret 启动服务：

```bash
git clone https://github.com/ProgramYin/JunVideo.git /opt/JunVideo
cd /opt/JunVideo
sudo bash deploy/bootstrap-domestic-api.sh
sudo nano /opt/JunVideo/.env.domestic-api
sudo bash deploy/bootstrap-domestic-api.sh
```

如果 DNS 已经指向本机，可在第二次运行时指定域名：

```bash
sudo API_DOMAIN=api.example.cn bash deploy/bootstrap-domestic-api.sh
```

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
