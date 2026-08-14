#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createCipheriv, randomBytes } from "node:crypto";

const [, , cookiePath, providedKey] = process.argv;
if (!cookiePath) {
  console.error("Usage: node scripts/encrypt-ytdlp-cookies.mjs <cookies.txt> [32-byte-hex-or-base64url-key]");
  process.exit(1);
}

const cookieText = (await readFile(cookiePath, "utf8")).replace(/^\uFEFF/u, "");
const firstLine = cookieText.split(/\r?\n/u, 1)[0]?.trim() ?? "";
if (!/^# (?:HTTP Cookie File|Netscape HTTP Cookie File)$/u.test(firstLine)) {
  throw new Error("The input must be a Netscape-format cookie file whose first line is a cookie-file header.");
}

function decodeKey(value) {
  if (/^[0-9a-f]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length !== 32) throw new Error("The key must be 32 bytes as 64 hex or base64url.");
  return decoded;
}

const key = providedKey ? decodeKey(providedKey.trim()) : randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([cipher.update(cookieText, "utf8"), cipher.final()]);
const envelope = [
  "jv1",
  iv.toString("base64url"),
  cipher.getAuthTag().toString("base64url"),
  ciphertext.toString("base64url"),
].join(".");

console.log(`# Store these two lines as separate Vercel Production environment secrets.`);
console.log(`YTDLP_COOKIES_ENCRYPTION_KEY=${key.toString("base64url")}`);
console.log(`YTDLP_COOKIES_ENCRYPTED=${envelope}`);
