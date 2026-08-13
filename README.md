# JunVideo

JunVideo 是一个简约的媒体链接解析工作台：用户注册后可以粘贴公开页面链接，查看平台识别、媒体元数据以及视频/音频下载入口。默认界面为中文，也可以切换英文；免费账号每天 10 次，VIP 账号不受次数限制。

## 当前实现

- React + Vite 前端，Express + TypeScript API。
- PostgreSQL 持久化用户、解析任务和每日用量。
- JWT 登录、bcrypt 密码哈希、并发安全的每日额度计数。
- 抖音、小红书、Bilibili 优先，另外提供常见海外/国内平台的识别和扩展入口。
- 解析器采用可替换的适配器接口；默认尝试调用 `yt-dlp`，没有安装时可以用 `PARSER_MODE=mock` 体验完整 UI。
- 开发环境提供明确标注的 VIP 开通接口，为真实支付 webhook 预留位置；不会产生真实扣款。

解析能力受来源平台链接有效期、登录状态、地区、Cookie、反爬策略、媒体格式以及 `ffmpeg` 是否可用影响。项目不绕过 DRM、登录墙或付费墙，也不永久缓存视频内容。请只保存你有权使用的公开内容，并遵守来源平台条款与版权规则。

## 本地运行

环境要求：Node.js 20+、PostgreSQL 14+。本机默认连接配置与你给出的环境一致：`localhost:5432` / `postgres` / `postgres`。先创建数据库：

```sql
CREATE DATABASE junvideo;
```

然后：

```powershell
Copy-Item .env.example .env
npm install
npm run db:init
npm run dev
```

打开 http://localhost:5173。API 默认运行在 http://localhost:4000。

默认语言由 `.env` 中的 `VITE_DEFAULT_LOCALE=zh` 配置，也可以改为 `en`；用户切换后的选择会保存在浏览器本地。

### 真实解析引擎

推荐安装官方 `yt-dlp` 与 `ffmpeg`：

```powershell
npm run setup:ytdlp
```

脚本会把官方 release 放入 `bin/yt-dlp.exe`；如果系统已有 `yt-dlp`，也可以设置 `.env` 的 `YTDLP_PATH` 或放入 `PATH`。视频下载会在请求时重新调用 yt-dlp 获取新鲜的签名地址；遇到视频/音频分离格式时由 yt-dlp 调用 ffmpeg 合并为 MP4。没有 yt-dlp 时，可在 `.env` 写入 `PARSER_MODE=mock`，用于接口和界面验收。

部分公开链接（尤其是抖音等平台的近期页面）会要求解析器带上一个新鲜的、由你授权使用的浏览器会话。此时只配置下面两项中的一项：

```powershell
YTDLP_COOKIES_FILE=D:\private\junvideo-cookies.txt
# 或：YTDLP_COOKIES_FROM_BROWSER=chrome
```

Cookie 文件、浏览器 profile 和登录凭据不要提交到仓库，也不要用它们绕过登录墙、付费墙或平台访问控制。没有可用会话时，API 会返回可读的提示；小红书还会区分视频笔记与图片笔记。

开发环境可以调用 `POST /api/dev/vip/activate` 为当前账号开启本地测试 VIP；生产环境该接口关闭，真实支付订单和 webhook 需要接入独立的 billing service。

视频下载入口不会复用解析阶段缓存的临时媒体 URL，而是按用户选择的格式重新授权下载；视频与音频分离时自动合并为带声音的 MP4。音频和封面仍通过鉴权代理读取平台返回的媒体流。请配置可执行的 `FFMPEG_PATH`，否则分离视频无法合并。

## 常用命令

```powershell
npm run build       # 构建 API 与前端
npm run setup:xhs   # 下载官方 XHS-Downloader Windows 旁路程序
npm run smoke       # API 已启动且数据库已初始化时执行基础冒烟测试
npm run smoke:priority # 对抖音/小红书/Bilibili 执行三轮“先解析、后探测下载”回归
npm run smoke:cases # 读取 测试用例.txt，逐条验证中文文案解析和成功项的二阶段下载探测
npm run test        # 服务端测试（若有）
```

解析采用两阶段：第一次请求只调用 yt-dlp 的 metadata 模式（`--skip-download`），返回平台、标题、封面、视频/音频格式和临时下载地址，不拉取媒体正文；用户点击视频、音频或封面按钮后，第二次请求才通过鉴权代理实际读取对应媒体流。`npm run smoke:priority` 会重复三轮并检查这三个下载分类的响应头与媒体流探测字节；`npm run smoke:cases` 的二阶段视频探测会选择每条成功任务中最小的已保留视频格式，避免回归测试为了验证响应头而下载数百 MB 的最高画质，生产界面仍按用户选择的格式下载。

## 可扩展设计

平台识别、解析器调用和结果标准化分离在 `server/src` 中。增加平台时，优先添加平台 detector / adapter，不要把平台特判散落在路由；增加支付时，把真实订单和 webhook 接在 billing service 旁边，不要直接把前端按钮视作生产权益凭证。

## Input and startup fixes

- `url` / `sourceUrl` accept pasted Chinese share text, Markdown-wrapped links, and links without a scheme. The API extracts the first URL before HTTP(S) and safety validation.
- The media proxy retries transient CDN responses (408/425/429/5xx) a limited number of times, and large response bodies are not cut off by a fixed 60-second body timeout.
- `start-junvideo.bat` applies the database schema, starts the API, waits for `/api/health`, and only then starts the web app so the UI does not race the API startup.
- Some unauthenticated Douyin/Xiaohongshu sources still require a fresh authorized browser session. Configure `YTDLP_COOKIES_FILE` or `YTDLP_COOKIES_FROM_BROWSER` when you are authorized to access that content; DRM, login-wall, and paywall bypass are not provided.
- For Douyin specifically, JunVideo now falls back to a one-time isolated Chrome/Edge page when yt-dlp's direct detail request is rejected. The fallback reads only the public page response and does not import your browser profile or cookies. Set `DOUYIN_BROWSER_FALLBACK=false` to disable it, or set `JUNVIDEO_BROWSER_PATH` when Chrome/Edge is installed outside the standard path.

## GitHub upstream adapters

- The primary engine is the official [yt-dlp](https://github.com/yt-dlp/yt-dlp). `npm run setup:ytdlp` downloads the current Windows binary from its GitHub release endpoint. JunVideo keeps the upstream extractor boundary instead of copying platform-specific code into the API.
- Douyin uses an isolated public-page browser fallback when the upstream direct detail request is rejected. It reads public page responses only and never imports the user's browser profile or cookies.
- Xiaohongshu can optionally use the official [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) API as a process-separated sidecar. The project is not vendored into JunVideo; this keeps its GPL-3.0 code and its configuration boundary separate. Start its API mode, then configure:

```powershell
XHS_DOWNLOADER_API_URL=http://127.0.0.1:5556/xhs/detail
XHS_DOWNLOADER_TIMEOUT_MS=20000
# Optional, only when the source requires an authorized session/proxy.
XHS_DOWNLOADER_COOKIE=
XHS_DOWNLOADER_PROXY=
```

The sidecar endpoint is called only after the normal yt-dlp attempt cannot produce safe XHS media formats. Its response is normalized into JunVideo's resolution-sorted video formats, optional audio formats, and cover image. `XHS_DOWNLOADER_COOKIE` and `XHS_DOWNLOADER_PROXY` are forwarded per request when configured; JunVideo does not bypass login, verification, DRM, or paywalls.

### Format retention and display policy

JunVideo persists every normalized, structurally unique video format in `metadata.allVideoFormats`. The workspace intentionally displays only one format per detected height: the highest FPS stream wins, then bitrate, width, audio presence, and file size are used as tie breakers. A hidden remembered format can still be downloaded by its format id through the authenticated proxy API, while ordinary users see a short resolution list.

## Subtitle text extraction (no AI)

JunVideo reads text tracks already supplied by the source media. It does not invoke Whisper, an online language model, speech recognition, or screen OCR. The endpoint is `POST /api/extract-text/:jobId`; its optional body is `{ "trackId": "...", "language": "zh-CN", "includeTimestamps": false }`. When the track and language fields are omitted, the server deterministically selects a track by language, manual-versus-automatic origin, and subtitle format. The workspace exposes the same track and language choices. The retired `/api/transcribe/:jobId` name remains a compatibility alias, but it runs the same non-AI subtitle pipeline.

The platform-general pipeline has two layers: `yt-dlp` discovers manual or automatic tracks exposed by a site, then a DNS-pinned and byte-limited HTTP client downloads the selected text track; `ffprobe` and `ffmpeg` inspect embedded text subtitle streams only after a bounded media file has been stored locally. Inputs such as VTT, SRT, ASS/SSA, TTML/SRV, and JSON3 are normalized into cues before markup cleanup, consecutive-duplicate removal, and plain-text assembly. `TEXT_EXTRACTION_MAX_BYTES`, `TEXT_EXTRACTION_MAX_CUES`, `TEXT_EXTRACTION_MAX_CHARS`, and `TEXT_EXTRACTION_TIMEOUT_MS` bound each request. Re-parse the source when a provider's signed subtitle URL has expired.

The boundary is explicit: videos without a subtitle track, speech-only media, captions burned into video frames, and bitmap formats such as PGS, VobSub, or DVB cannot be converted into text. The API returns `TEXT_TRACK_NOT_FOUND` and never silently falls back to AI. Make `ffmpeg` and `ffprobe` available through `FFMPEG_PATH` and `FFPROBE_PATH`. Only public, authorized media is supported; JunVideo does not bypass DRM, login walls, paywalls, or access controls.

The implementation follows [yt-dlp's subtitle options](https://github.com/yt-dlp/yt-dlp#subtitle-options) and its extractor contract for `subtitles`/`automatic_captions`, including URL-backed and inline tracks. Embedded-track handling follows the official [ffprobe](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffprobe.texi) and [FFmpeg stream-selection](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffmpeg.texi) contracts. Libraries such as [subtitle.js](https://github.com/gsantiago/subtitle.js) and [Subforge](https://github.com/wiedymi/subforge) informed the format review; JunVideo keeps a small internal parser layer with repository-owned contract tests so the API does not depend on a young or partial parser package at runtime.

## 生产部署

The repository includes reusable production configurations for PostgreSQL on Supabase, Express with yt-dlp and FFmpeg in a Vercel Container, and the static client on Cloudflare Pages. `Dockerfile.vercel` installs yt-dlp `2026.7.4` plus FFmpeg/ffprobe; it contains no Whisper package, model weights, or OpenAI dependency. Database migrations live in `supabase/migrations`, while `public/_headers` and `public/_redirects` provide security headers and SPA fallback behavior.

1. 在 Supabase 创建项目，取得 Transaction Pooler 连接串后执行迁移：

   ```powershell
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

2. 在 Vercel 导入仓库并使用 `Dockerfile.vercel`，至少配置：

   ```text
   DATABASE_URL=<Supabase transaction pooler URL>
   DATABASE_SSL=true
   DATABASE_POOL_MAX=3
   JWT_SECRET=<at least 32 random characters>
   CORS_ORIGIN=https://<cloudflare-pages-domain>
   ```

   Vercel 同源版本会同时提供网页和 `/api`，因此无需设置 `VITE_API_BASE_URL`。

3. 发布 Cloudflare Pages 前，把 API 地址作为 Vite 构建变量：

   ```powershell
   $env:VITE_API_BASE_URL="https://<vercel-domain>/api"
   npm run build
   npx wrangler pages deploy dist/client --project-name junvideo
   ```

Cloudflare Pages 域名确定后，应同步写入 Vercel 的 `CORS_ORIGIN` 并重新部署。生产环境会自动关闭开发 VIP 激活入口；真实会员计费仍需另接订单与 webhook 服务。
