import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const target = resolve(process.env.YTDLP_PATH || 'bin/yt-dlp.exe');
const url = process.platform === 'win32'
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

console.log(`Downloading yt-dlp from ${url}`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, Buffer.from(await response.arrayBuffer()));
if (process.platform !== 'win32') await chmod(target, 0o755);
console.log(`yt-dlp is ready at ${target}`);
