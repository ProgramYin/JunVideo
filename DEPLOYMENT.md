# JunVideo 线上部署手册

本文档记录 JunVideo 当前的线上地址、账号标识、部署流程、环境变量和常见故障处理。

> 安全说明：本文档不保存任何密码、数据库连接串、JWT 密钥或 Cookie 内容。密码和 Secret 只应保存在 GitHub/Vercel/Cloudflare/Supabase 的密码管理器或环境变量中，不能提交到 Git。

## 1. 当前线上地址

| 用途 | 地址 |
| --- | --- |
| GitHub 仓库 | <https://github.com/ProgramYin/JunVideo> |
| Vercel 项目 | <https://vercel.com/programyins-projects/jun-video> |
| Vercel 部署列表 | <https://vercel.com/programyins-projects/jun-video/deployments> |
| Vercel 环境变量 | <https://vercel.com/programyins-projects/jun-video/settings/environment-variables> |
| Vercel 生产 API | <https://jun-video.vercel.app> |
| API 健康检查 | <https://jun-video.vercel.app/api/health> |
| Cloudflare Pages 前端 | <https://jun-video.pages.dev/> |
| Cloudflare 控制台 | <https://dash.cloudflare.com/> |
| Supabase 项目控制台 | <https://supabase.com/dashboard/project/wlzeyfzzpwmysjijrxvk> |

当前 Git 分支为 `main`，最近一次已部署提交为 `cc1f433`。

## 2. 账号和凭据登记

| 服务 | 账号/项目标识 | 密码或 Secret |
| --- | --- | --- |
| GitHub | 用户/组织：`ProgramYin`；仓库：`JunVideo` | 不写入本文档，从密码管理器取用 |
| Vercel | 团队/项目：`programyin's projects / jun-video` | 不写入本文档，从密码管理器取用 |
| Cloudflare | Pages 项目：`junvideo`；域名：`jun-video.pages.dev` | 当前登录账号以控制台会话为准，不写入本文档 |
| Supabase | 项目 ref：`wlzeyfzzpwmysjijrxvk` | 数据库密码不写入本文档，只通过 `DATABASE_URL` 配置 |
| JunVideo 应用 | 使用注册页面创建的 Email 账号 | 当前没有可安全公开的固定账号/密码；不要使用 GitHub 或 Vercel 密码 |

如果出现 `Email or password is incorrect.`，请确认使用的是 JunVideo 注册账号，而不是 GitHub、Vercel 或 Cloudflare 的账号；密码重置应通过应用现有的账号管理流程完成。

## 3. 第一次部署准备

### 3.1 本地准备

要求：Node.js 24、npm、Git；生产容器会自动安装 FFmpeg、ffprobe 和 yt-dlp。

```powershell
git clone https://github.com/ProgramYin/JunVideo.git
Set-Location JunVideo
npm ci
npm run build
npm test
```

### 3.2 初始化 Supabase

1. 在 Supabase 创建或打开项目。
2. 在项目的 Connect 页面复制 Transaction Pooler 连接串。
3. 使用 Supabase CLI 推送迁移：

```powershell
npx supabase login
npx supabase link --project-ref wlzeyfzzpwmysjijrxvk
npx supabase db push
```

`DATABASE_URL` 使用 Transaction Pooler 连接串，不要把连接串写入仓库或聊天记录。

## 4. Vercel 部署 API

### 4.1 导入仓库

打开 [Vercel 项目](https://vercel.com/programyins-projects/jun-video)，确认 GitHub 仓库为 `ProgramYin/JunVideo`，生产分支为 `main`。项目使用仓库内的 `Dockerfile.vercel`，不需要把 `node_modules` 或 `dist` 提交到 Git。

### 4.2 配置 Vercel Production 环境变量

在 [Vercel Environment Variables](https://vercel.com/programyins-projects/jun-video/settings/environment-variables) 中选择 `Production`，至少确认以下变量已配置：

```text
DATABASE_URL=<Supabase Transaction Pooler 连接串>
DATABASE_SSL=true
DATABASE_POOL_MAX=3
JWT_SECRET=<至少 32 个字符的随机值>
CORS_ORIGIN=https://jun-video.pages.dev
```

以下变量由 `Dockerfile.vercel` 提供默认值，除非确有需要，不要覆盖：

```text
NODE_ENV=production
SERVE_CLIENT=true
PARSER_MODE=yt-dlp
YTDLP_PATH=/opt/junvideo-venv/bin/yt-dlp
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
DEV_VIP_ENABLED=false
```

### 4.3 配置抖音授权 Cookie

抖音某些链接需要登录态。不要把浏览器 Cookie、`cookies.txt` 或明文 Secret 提交到 Git。

先从已授权的浏览器导出 Netscape 格式 Cookie 文件，然后在本地执行：

```powershell
node scripts/encrypt-ytdlp-cookies.mjs D:\private\douyin-cookies.txt
```

脚本会输出两行，将它们作为两个独立的 Vercel Production 环境变量保存：

```text
YTDLP_COOKIES_ENCRYPTION_KEY=<脚本输出的 key>
YTDLP_COOKIES_ENCRYPTED=jv1.<iv>.<auth-tag>.<ciphertext>
```

注意事项：

- 两个变量必须同时存在，不能只配置其中一个。
- `YTDLP_COOKIES_FILE`、`YTDLP_COOKIES_FROM_BROWSER` 和加密 Cookie 不能同时配置，三选一。
- 加密 Cookie 会在运行时临时解密到容器的 `0600` 临时文件，供解析、媒体下载和字幕下载使用。
- Cookie 失效后重新导出、重新加密并更新两个 Vercel 变量，然后重新部署。
- 不要把两行 Secret 发到聊天中，也不要把它们写进本文档。

### 4.4 触发部署

保存环境变量后，进入 [Deployments](https://vercel.com/programyins-projects/jun-video/deployments)，对最新 `main` 部署执行 Redeploy；也可以推送新的代码提交：

```powershell
git add .
git commit -m "chore: redeploy production configuration"
git push origin main
```

## 5. Cloudflare Pages 部署前端

当前前端地址为 <https://jun-video.pages.dev/>，API 地址为 `https://jun-video.vercel.app/api`。

### 5.1 通过 GitHub 自动部署

如果 Cloudflare Pages 项目已经连接 GitHub：

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 进入 `Workers & Pages`，打开 Pages 项目 `junvideo`。
3. 确认仓库为 `ProgramYin/JunVideo`，生产分支为 `main`。
4. 确认构建命令为 `npm run build`，输出目录为 `dist/client`。
5. 设置构建变量：

```text
VITE_API_BASE_URL=https://jun-video.vercel.app/api
```

6. 保存后重新部署。

### 5.2 使用 Wrangler 手动部署

```powershell
npx wrangler login
$env:VITE_API_BASE_URL="https://jun-video.vercel.app/api"
npm ci
npm run build
npx wrangler pages deploy dist/client --project-name junvideo
```

如果更换了 Vercel 域名，必须同步更新 `VITE_API_BASE_URL` 和 Vercel 的 `CORS_ORIGIN`，然后分别重新部署。

## 6. 日常发布流程

以后只需要在本地执行：

```powershell
Set-Location D:\AICode\JunVideo
npm ci
npm test
npm run build
git status
git add .
git commit -m "描述本次修改"
git push origin main
```

推送成功后：

1. Vercel 自动构建 API 和同源版本。
2. Cloudflare Pages 在已连接 GitHub 的情况下自动构建前端；未连接时执行第 5.2 节的 Wrangler 命令。
3. 等待部署状态变为 `Ready`。
4. 打开健康检查确认 API 正常。

## 7. 发布后检查

```powershell
Invoke-RestMethod https://jun-video.vercel.app/api/health | ConvertTo-Json -Compress
```

正常结果应满足：

```text
ok=true
status="ok"
parser.available=true
features.authorizedSession=true  # 配置加密 Cookie 后应为 true
```

前端检查：

1. 打开 <https://jun-video.pages.dev/>。
2. 使用 JunVideo 注册账号登录。
3. 粘贴一个公开的 YouTube、Bilibili 或抖音链接。
4. 点击“开始解析”。
5. 检查视频格式、音频下载和字幕入口。

## 8. 常见故障

### `authorizedSession=false`

说明 Vercel 运行环境没有同时读到两个加密 Cookie 变量。检查变量环境是否为 `Production`、变量名是否完全一致，然后 Redeploy。

### `This source requires a fresh authorized browser session`

说明目标平台要求新的登录态，或 Cookie 已过期。重新导出 Netscape Cookie，运行加密脚本，更新两个 Vercel Secret 后重新部署。JunVideo 不绕过 DRM、付费墙或平台访问控制。

### `Email or password is incorrect.`

这是应用登录账号错误，不是视频解析错误。请使用 JunVideo 注册账号；GitHub、Vercel、Cloudflare 和 Supabase 的密码彼此不通用。

### 线上 API 正常但前端解析失败

检查：

- Cloudflare Pages 的 `VITE_API_BASE_URL` 是否为 `https://jun-video.vercel.app/api`。
- Vercel 的 `CORS_ORIGIN` 是否为 `https://jun-video.pages.dev`。
- 两边修改后是否都重新部署。

### 不要提交的文件

```text
.env
cookies.txt
*cookie*
DATABASE_URL
JWT_SECRET
YTDLP_COOKIES_ENCRYPTION_KEY
YTDLP_COOKIES_ENCRYPTED
```
