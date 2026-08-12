import "dotenv/config";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const requirements = resolve(root, "requirements-transcription.txt");
const configured = process.env.PYTHON_PATH?.trim();
const candidates = [
  configured,
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe")
    : undefined,
  process.platform === "win32" && process.env.ProgramFiles
    ? join(process.env.ProgramFiles, "Python312", "python.exe")
    : undefined,
  "python3",
  "python",
  "py",
].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);

if (!existsSync(requirements)) {
  console.error(`Missing transcription requirements file: ${requirements}`);
  process.exit(1);
}

let pythonPath;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", shell: false });
  if (probe.status === 0) {
    pythonPath = candidate;
    break;
  }
}

if (!pythonPath) {
  console.error("Python 3.10+ was not found. Install Python, or set PYTHON_PATH to python.exe.");
  process.exit(1);
}

console.log(`Installing transcription dependencies with ${pythonPath}...`);
const result = spawnSync(pythonPath, ["-m", "pip", "install", "-r", requirements], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
