import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

export function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> & { stdout: Readable; stderr: Readable };
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }) as typeof child;
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationError: Error | undefined;

    const finish = (error?: Error, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(result as ProcessResult);
    };

    const terminate = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      try {
        child.kill();
      } catch {
        finish(error);
        return;
      }
      // A child that ignores the first termination signal must not leave the
      // request hanging forever or keep a temporary download directory open.
      killTimer = setTimeout(() => finish(error), 1_000);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (terminationError) return;
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        terminate(new Error("Process output exceeded the configured safety limit."));
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", (error) => {
      if (terminationError) finish(terminationError);
      else finish(error);
    });
    child.once("close", (exitCode, signal) => {
      if (terminationError) finish(terminationError);
      else finish(undefined, { exitCode, signal, stdout, stderr });
    });

    timer = setTimeout(() => terminate(new Error(`Process timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
}
