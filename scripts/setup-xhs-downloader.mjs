import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const target = resolve(process.env.XHS_DOWNLOADER_PATH || '.runtime/xhs-downloader/main.exe');

if (process.platform !== 'win32') {
  throw new Error('The bundled XHS-Downloader setup currently supports Windows only. Install the upstream project manually on other platforms.');
}

try {
  await execFileAsync('where.exe', ['powershell'], { windowsHide: true });
} catch {
  throw new Error('PowerShell is required to extract the official XHS-Downloader Windows package.');
}

try {
  await access(target);
  console.log(`XHS-Downloader is already ready at ${target}`);
  process.exit(0);
} catch {
  // Continue with the download when the target does not exist.
}

const releaseResponse = await fetch('https://api.github.com/repos/JoeanAmier/XHS-Downloader/releases/latest', {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JunVideo-setup' },
});
if (!releaseResponse.ok) throw new Error(`Could not read the XHS-Downloader release metadata: HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const asset = Array.isArray(release.assets)
  ? release.assets.find((item) => typeof item?.name === 'string' && /Windows_X64\.zip$/iu.test(item.name))
  : null;
if (!asset?.browser_download_url || !asset.name) {
  throw new Error('The latest XHS-Downloader release does not contain a Windows X64 package.');
}

const archive = resolve('.runtime', asset.name);
const destination = dirname(target);
await mkdir(destination, { recursive: true });
console.log(`Downloading XHS-Downloader ${release.tag_name ?? ''} from ${asset.browser_download_url}`);
const packageResponse = await fetch(asset.browser_download_url, {
  redirect: 'follow',
  headers: { Accept: 'application/octet-stream', 'User-Agent': 'JunVideo-setup' },
});
if (!packageResponse.ok) throw new Error(`XHS-Downloader download failed: HTTP ${packageResponse.status}`);
await writeFile(archive, Buffer.from(await packageResponse.arrayBuffer()));

const escapedArchive = archive.replaceAll("'", "''");
const escapedDestination = destination.replaceAll("'", "''");
await execFileAsync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command', `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });

if (!await fileExists(target)) {
  throw new Error(`The package was extracted, but main.exe was not found at ${target}.`);
}
await rm(archive, { force: true });
console.log(`XHS-Downloader is ready at ${target}`);

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
