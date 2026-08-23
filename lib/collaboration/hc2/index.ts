/**
 * HC-2 is a side-effect-free, explicitly invoked namespace. It is intentionally
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
export * from "./portable-folder.ts";
export * from "./coordination-store.ts";
export * from "./web-locks.ts";
export * from "./opfs-cache.ts";
export * from "./capability-probes.ts";
export * from "./failure-injection.ts";
export * from "./storage-coordinator.ts";
export * from "./hc1-object-verifier.ts";
export * from "./storage-observations.ts";
