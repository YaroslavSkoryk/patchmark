import type { AgentExchangeConnector } from "./contracts.ts";
import { LocalCodexConnectorSession } from "./local-codex-connector.ts";

export type AgentExchangeProductQualificationDriver = Readonly<{
  createConnector(): AgentExchangeConnector;
  createOperationId(): string;
}>;

let localCodexSession: LocalCodexConnectorSession | null = null;

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
export function readAgentExchangeProductQualificationDriver(): AgentExchangeProductQualificationDriver {
  const driver = globalThis.__patchmarkAgentExchangeProductQualificationDriver;
  if (driver) {
    if (
      typeof driver.createConnector !== "function" ||
      typeof driver.createOperationId !== "function"
    ) {
      throw new Error("The Agent Exchange qualification connector is invalid.");
    }
    return driver;
  }
  localCodexSession ??= new LocalCodexConnectorSession();
  return Object.freeze({
    createConnector: () => localCodexSession!.createConnector(),
    createOperationId: () => crypto.randomUUID()
  });
}

export const readInjectedAgentExchangeProductQualificationDriver =
  readAgentExchangeProductQualificationDriver;
