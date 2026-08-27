import type {
  Hc3ProductAuthorityEvidence,
  Hc3ProductActionInput,
  Hc3ProductSnapshot
} from "../lib/collaboration/hc3/index.ts";
import type { Hc3QrMatrix } from "../lib/collaboration/hc3/qr-provider.ts";

type Assert<T extends true> = T;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Extends<A, B> = A extends B ? true : false;

type ProductSurfaceAssertions = [
  Assert<Extends<Hc3ProductSnapshot["authority"], "none">>,
  Assert<Extends<Hc3ProductAuthorityEvidence["authority"], "hc2_hc3">>,
  Assert<HasKey<Hc3ProductAuthorityEvidence, "durable_revalidation">>,
  Assert<Extends<Hc3QrMatrix["authority"], "none">>,
  Assert<HasKey<Hc3ProductActionInput, "expected_revision">>,
  Assert<HasKey<Hc3ProductActionInput, "project_id">>,
  Assert<HasKey<Hc3ProductSnapshot, "full_history_verified">>,
  Assert<HasKey<Hc3ProductSnapshot, "source_project_immutable">>
];

declare const assertions: ProductSurfaceAssertions;
void assertions;
