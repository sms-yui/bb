import { TUNNEL_TARGET_HEADER } from "./protocol-headers.js";

export const RESP_HEAD_TIMEOUT_MS = 30_000;
export const VOICE_TRANSCRIPTION_RESP_HEAD_TIMEOUT_MS = 90_000;
export const POOLED_IMAGE_RESP_HEAD_TIMEOUT_MS = 360_000;
const VOICE_TRANSCRIPTION_PATH = "/api/v1/system/voice-transcription";
const POOLED_IMAGE_PATHS = new Set([
  "/api/v1/plugins/account-pool/http/v1/images/generations",
  "/api/v1/plugins/account-pool/http/v1/images/edits",
]);

export function responseHeadTimeoutMs(
  method: string,
  url: URL,
  headers: Headers,
): number {
  const target = headers.get(TUNNEL_TARGET_HEADER);
  if (method !== "POST" || (target !== null && target !== "")) {
    return RESP_HEAD_TIMEOUT_MS;
  }
  if (url.pathname === VOICE_TRANSCRIPTION_PATH) {
    return VOICE_TRANSCRIPTION_RESP_HEAD_TIMEOUT_MS;
  }
  if (POOLED_IMAGE_PATHS.has(url.pathname)) {
    return POOLED_IMAGE_RESP_HEAD_TIMEOUT_MS;
  }
  return RESP_HEAD_TIMEOUT_MS;
}
