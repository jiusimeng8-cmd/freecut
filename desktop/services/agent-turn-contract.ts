/**
 * The server's Agent Turn request schema, mirrored as constants.
 *
 * These caps live in the cloud's zod schema (`lib/agents/turn.ts`). Exceeding
 * any of them is not a soft failure: the request is rejected with a bare HTTP
 * 400 before it reaches application code, and the only signal that reaches the
 * user is a generic error code.
 *
 * That is not hypothetical. The client window was widened from 8 to 30 recent
 * turns without touching the server's `.max(24)`; every agent run on a thread
 * silently broke the moment it accumulated a 25th turn. Nothing in the test
 * suite compared the two numbers, so it shipped green.
 *
 * So: clamp outgoing payloads to these values rather than trusting callers, and
 * when the server schema changes, change it here in the same breath. These must
 * mirror what the deployed server enforces today, not what a pending deploy
 * will enforce — a value the server has not adopted yet is the same outage.
 *
 * Verified against the compiled bundle in the running container rather than the
 * source on disk, because the source is only a promise until it is rebuilt.
 */
export const AGENT_TURN_SERVER_LIMITS = {
  /** `recentMessages` array length. */
  recentMessages: 60,
  /** Per-message `text`, and the context `summary`. */
  textChars: 32_768,
  /** `tools` array length. */
  tools: 220,
} as const
