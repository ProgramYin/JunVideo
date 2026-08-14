import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENVELOPE_VERSION = "jv1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const COOKIE_FILE_HEADER = /^# (?:HTTP Cookie File|Netscape HTTP Cookie File)$/u;

export interface MaterializedCookieFile {
  filePath: string;
  cleanup: () => void;
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Cookie encryption envelope contains an invalid base64url segment.");
  }
  return Buffer.from(value, "base64url");
}

export function decodeCookieEncryptionKey(value: string): Buffer {
  const normalized = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }
  const decoded = base64UrlDecode(normalized);
  if (decoded.length !== KEY_BYTES) {
    throw new Error("YTDLP_COOKIES_ENCRYPTION_KEY must be 32 bytes as 64 hex or base64url.");
  }
  return decoded;
}

function validateCookieText(cookieText: string): string {
  const normalized = cookieText.replace(/^\uFEFF/u, "");
  const firstLine = normalized.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (!COOKIE_FILE_HEADER.test(firstLine)) {
    throw new Error("The decrypted cookie payload is not a Netscape-format cookie file.");
  }
  return normalized;
}

/**
 * Encrypt a Netscape cookie file into the compact value accepted by
 * YTDLP_COOKIES_ENCRYPTED. The key is supplied separately in production.
 */
export function encryptCookieFileText(cookieText: string, key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error("Cookie encryption key must be 32 bytes.");
  const plaintext = Buffer.from(validateCookieText(cookieText), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    base64UrlEncode(iv),
    base64UrlEncode(authTag),
    base64UrlEncode(ciphertext),
  ].join(".");
}

export function decryptCookieEnvelope(envelope: string, key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error("Cookie encryption key must be 32 bytes.");
  const parts = envelope.trim().split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("YTDLP_COOKIES_ENCRYPTED has an unsupported envelope format.");
  }
  const iv = base64UrlDecode(parts[1]);
  const authTag = base64UrlDecode(parts[2]);
  const ciphertext = base64UrlDecode(parts[3]);
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
    throw new Error("YTDLP_COOKIES_ENCRYPTED has invalid encrypted cookie data.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return validateCookieText(plaintext);
  } catch {
    throw new Error("YTDLP_COOKIES_ENCRYPTED could not be authenticated with the configured key.");
  }
}

export function materializeEncryptedCookieFile(envelope: string, key: Uint8Array): MaterializedCookieFile {
  const cookieText = decryptCookieEnvelope(envelope, key);
  const directory = mkdtempSync(join(tmpdir(), "junvideo-ytdlp-cookies-"));
  const filePath = join(directory, "cookies.txt");
  try {
    chmodSync(directory, 0o700);
    writeFileSync(filePath, cookieText, { encoding: "utf8", mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(directory, { recursive: true, force: true });
  };
  return { filePath, cleanup };
}

/**
 * Used by the local encryption helper without exposing key-generation details
 * to the server config module.
 */
export function generateCookieEncryptionKey(): Buffer {
  return randomBytes(KEY_BYTES);
}
