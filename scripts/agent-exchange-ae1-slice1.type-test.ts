import type {
  AgentExchangeConnector,
  AgentExchangeConnectorSubmission,
  AgentExchangeResponseImporter
} from "../lib/agent-exchange/contracts.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type ConnectorSubmissionKeys = Expect<
  Equal<
    keyof AgentExchangeConnectorSubmission,
    "binding" | "request_bytes" | "signal"
  >
>;
type ConnectorKeys = Expect<
  Equal<
    keyof AgentExchangeConnector,
    "checkAvailability" | "close" | "descriptor" | "submit"
  >
>;
type ForbiddenConnectorAuthority = Expect<
  Equal<
    Extract<
      keyof AgentExchangeConnectorSubmission,
      | "acceptPatch"
      | "collaborationCustody"
      | "commentStore"
      | "documentStore"
      | "editor"
      | "patchStore"
      | "project"
      | "projectStore"
      | "resolveComment"
    >,
    never
  >
>;
type ImporterIsSeparateFromConnector = Expect<
  Equal<
    Extract<keyof AgentExchangeConnector, keyof AgentExchangeResponseImporter<unknown>>,
    never
  >
>;

export type AgentExchangeBoundaryTypeEvidence = Readonly<{
  connector: ConnectorKeys;
  forbidden_authority: ForbiddenConnectorAuthority;
  importer_separation: ImporterIsSeparateFromConnector;
  submission: ConnectorSubmissionKeys;
}>;
