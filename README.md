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

脚本会把官方 release 放入 `bin/yt-dlp.exe`；如果系统已有 `yt-dlp`，也可以设置 `.env` 的 `YTDLP_PATH` 或放入 `PATH`。当前界面会分别提供视频流和音频流下载；若要在服务器端合并为单文件，后续可接入 ffmpeg 任务队列。没有二进制时，可在 `.env` 写入 `PARSER_MODE=mock`，用于接口和界面验收。

部分公开链接（尤其是抖音等平台的近期页面）会要求解析器带上一个新鲜的、由你授权使用的浏览器会话。此时只配置下面两项中的一项：

```powershell
YTDLP_COOKIES_FILE=D:\private\junvideo-cookies.txt
# 或：YTDLP_COOKIES_FROM_BROWSER=chrome
```

Cookie 文件、浏览器 profile 和登录凭据不要提交到仓库，也不要用它们绕过登录墙、付费墙或平台访问控制。没有可用会话时，API 会返回可读的提示；小红书还会区分视频笔记与图片笔记。

开发环境可以调用 `POST /api/dev/vip/activate` 为当前账号开启本地测试 VIP；生产环境该接口关闭，真实支付订单和 webhook 需要接入独立的 billing service。

目前下载入口直接代理平台返回的视频/音频流；视频与音频分离时分别提供下载选项。`FFMPEG_PATH` 是后续服务端合并能力的预留配置，目前不会触发合并任务。

## 常用命令

```powershell
npm run build       # 构建 API 与前端
npm run setup:xhs   # 下载官方 XHS-Downloader Windows 旁路程序
npm run smoke       # API 已启动且数据库已初始化时执行基础冒烟测试
npm run smoke:priority # 对抖音/小红书/Bilibili 执行三轮“先解析、后探测下载”回归
npm run smoke:cases # 读取 测试用例.txt，逐条验证中文文案解析和成功项的二阶段下载探测
npm run test        # 服务端测试（若有）
```

解析采用两阶段：第一次请求只调用 yt-dlp 的 metadata 模式（`--skip-download`），返回平台、标题、封面、视频/音频格式和临时下载地址，不拉取媒体正文；用户点击视频、音频或封面按钮后，第二次请求才通过鉴权代理实际读取对应媒体流。`npm run smoke:priority` 会重复三轮并检查这三个下载分类的响应头与媒体流探测字节。

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

## Video transcription and correction

JunVideo now includes the reference Skill's workflow: `yt-dlp` metadata/stream selection, audio extraction through `ffmpeg`, local Whisper transcription, then transcript correction. The API endpoint is `POST /api/transcribe/:jobId`; the workspace exposes it below a successful parse result.

Install the optional local transcription runtime on the API machine:

```powershell
python -m pip install -r requirements-transcription.txt
```

`ffmpeg` must be installed and available through `FFMPEG_PATH`. `WHISPER_MODEL=tiny` is the fast default. `CORRECTION_MODE=rules` works offline with conservative common-ASR corrections; set `CORRECTION_MODE=openai` and configure `OPENAI_API_KEY` to use an OpenAI-compatible HTTP correction endpoint. The raw transcript is retained in the response alongside the corrected text, and temporary audio files are removed after each request.

The reference implementation is used for workflow and platform-boundary ideas, while JunVideo keeps yt-dlp as the primary extractor instead of vendoring a second platform parser. Only public, authorized media is supported; DRM, login walls, paywalls, and access-control bypass are not provided.
