import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The thinking levels pi accepts, in ascending order. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** An optional `:level` suffix on an `enabledModels` pattern (`anthropic/*:high`). */
export const THINKING_SUFFIX = new RegExp(`:(${THINKING_LEVELS.join("|")})$`);
