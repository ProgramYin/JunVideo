import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decodeCookieEncryptionKey,
  decryptCookieEnvelope,
  encryptCookieFileText,
  generateCookieEncryptionKey,
  materializeEncryptedCookieFile,
} from "./yt-dlp-cookies.js";

const cookieText = [
  "# Netscape HTTP Cookie File",
  ".douyin.com\tTRUE\t/\tTRUE\t4102444800\tmsToken\tredacted-test-token",
  "",
].join("\n");

test("encrypted yt-dlp cookies round-trip without exposing plaintext in the envelope", () => {
  const key = generateCookieEncryptionKey();
  const envelope = encryptCookieFileText(cookieText, key);

  assert.match(envelope, /^jv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(envelope.includes("redacted-test-token"), false);
  assert.equal(decryptCookieEnvelope(envelope, key), cookieText);
});

test("cookie encryption key accepts hex and base64url encodings", () => {
  const key = generateCookieEncryptionKey();
  assert.deepEqual(decodeCookieEncryptionKey(key.toString("hex")), key);
  assert.deepEqual(decodeCookieEncryptionKey(key.toString("base64url")), key);
});

test("materialized encrypted cookies use a temporary file and cleanup removes it", async () => {
  const key = generateCookieEncryptionKey();
  const materialized = materializeEncryptedCookieFile(encryptCookieFileText(cookieText, key), key);
  assert.equal(await readFile(materialized.filePath, "utf8"), cookieText);
  materialized.cleanup();
  await assert.rejects(() => readFile(materialized.filePath, "utf8"));
  materialized.cleanup();
});

test("encrypted cookie payloads reject tampering", () => {
  const key = generateCookieEncryptionKey();
  const envelope = encryptCookieFileText(cookieText, key);
  const parts = envelope.split(".");
  parts[2] = `${parts[2]?.startsWith("A") ? "B" : "A"}${parts[2]?.slice(1) ?? ""}`;
  const tampered = parts.join(".");
  assert.throws(() => decryptCookieEnvelope(tampered, key), /authenticated|invalid/i);
});
