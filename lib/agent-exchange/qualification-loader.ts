import { AgentExchangeOperationController } from "./operation-controller.ts";
import { prepareAgentExchange } from "./prepared-exchange.ts";
import { readAgentExchangeProductQualificationDriver } from "./product-driver.ts";

export {
  copyPreparedExchangeForManualDelivery,
  prepareAgentExchange
} from "./prepared-exchange.ts";
export {
  AgentExchangeOperationController,
  AgentExchangeOperationError
} from "./operation-controller.ts";
export {
  AgentExchangeActions,
  AgentExchangeActions as ReviewDeliveryActions
} from "../../components/agent-exchange/agent-exchange-actions.tsx";
export {
  readAgentExchangeProductQualificationDriver,
  readInjectedAgentExchangeProductQualificationDriver
} from "./product-driver.ts";
export {
  isLocalCodexPairableConnector
} from "./local-codex-connector.ts";
export type {
  AgentExchangeConnector,
  AgentExchangeConnectorResponse,
  AgentExchangeOperationBinding,
  AgentExchangeResponseBinding,
  PreparedAgentExchange
} from "./contracts.ts";

export function createReviewDeliveryController(): AgentExchangeOperationController {
  return new AgentExchangeOperationController();
}

export function prepareReviewDelivery(
  input: Parameters<typeof prepareAgentExchange>[0]
): ReturnType<typeof prepareAgentExchange> {
  return prepareAgentExchange(input);
}

export function readReviewDeliveryDriver(): ReturnType<
  typeof readAgentExchangeProductQualificationDriver
> {
  return readAgentExchangeProductQualificationDriver();
}
