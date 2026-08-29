import type { AgentExchangeConnector } from "./contracts.ts";

export type AgentExchangeProductQualificationDriver = Readonly<{
  createConnector(): AgentExchangeConnector;
  createOperationId(): string;
}>;

declare global {
  var __patchmarkAgentExchangeProductQualificationDriver:
    | AgentExchangeProductQualificationDriver
    | undefined;
}

/**
 * Reads the deterministic browser seam only after an explicit product action.
 * The seam is unreachable from production because its owning loader is removed
 * from the disabled production graph.
 */
export function readInjectedAgentExchangeProductQualificationDriver(): AgentExchangeProductQualificationDriver {
  const driver = globalThis.__patchmarkAgentExchangeProductQualificationDriver;
  if (
    !driver ||
    typeof driver.createConnector !== "function" ||
    typeof driver.createOperationId !== "function"
  ) {
    throw new Error("The Agent Exchange qualification connector is unavailable.");
  }
  return driver;
}
