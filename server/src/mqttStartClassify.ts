/**
 * v0.76.0 — classify the log level for an MQTT start-failure, extracted from
 * index.ts so the v0.75.0 boot-grace behaviour is unit-tested (it had zero
 * coverage and was never exercised in production because no post-deploy boot hit
 * a DNS race).
 *
 * The first `graceAttempts` failures that look like a boot-time DNS race
 * (EAI_AGAIN / ENOTFOUND / getaddrinfo) or the EcoFlow `8521 "signature is wrong"`
 * handshake error are benign — they self-heal within ~10 min on the retry backoff
 * while REST polling (the alarm data path) never stops — so they log at WARN. A
 * failure still recurring PAST the grace window, or any OTHER error class at any
 * attempt, is a genuine problem and logs at ERROR so it stands out instead of
 * being buried under benign boot artifacts.
 */

/** The boot-window transient error signatures (DNS race + EcoFlow auth handshake). */
export const MQTT_BOOT_TRANSIENT_RE = /EAI_AGAIN|ENOTFOUND|getaddrinfo|8521|signature is wrong/i;

export function classifyMqttStartFailure(
  attempt: number,
  message: string,
  graceAttempts: number,
): 'warn' | 'error' {
  return attempt < graceAttempts && MQTT_BOOT_TRANSIENT_RE.test(message) ? 'warn' : 'error';
}
