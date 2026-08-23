/**
 * HC-2 Slice 1 is a side-effect-free contract namespace. It is intentionally
 * not exported from ../index.ts and must remain unreachable from production
 * entrypoints until the final HC-2 audit authorizes integration.
 */
export * from "./versions.ts";
export * from "./identities.ts";
export * from "./limits.ts";
export * from "./platform-policy.ts";
export * from "./authority.ts";
export * from "./addresses.ts";
export * from "./records.ts";
export * from "./coordination.ts";
export * from "./crypto-contracts.ts";
export * from "./envelope.ts";
export * from "./recovery-policy.ts";
