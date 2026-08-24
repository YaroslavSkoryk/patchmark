import type { ControlEventId, ProjectId, PublicKeyId } from "../../identities.ts";
import type { RootAuthorityPurpose } from "../custody-types.ts";

type CommonRequest = Readonly<{
  request_id: string;
  password: Uint8Array;
}>;

export type Hc2RootRecoveryWorkerRequest =
  | (CommonRequest & Readonly<{
      operation: "create_root_kit";
      project_id: ProjectId;
      root_key_id: PublicKeyId;
      root_generation: bigint;
      salt: Uint8Array;
      nonce: Uint8Array;
    }>)
  | (CommonRequest & Readonly<{
      operation: "verify_root_kit";
      project_id: ProjectId;
      root_key_id: PublicKeyId;
      kit_bytes: Uint8Array;
      verification_challenge: Uint8Array;
    }>)
  | (CommonRequest & Readonly<{
      operation: "sign_root_authority";
      project_id: ProjectId;
      root_key_id: PublicKeyId;
      kit_bytes: Uint8Array;
      authority_purpose: RootAuthorityPurpose;
      authority_control_event_id: ControlEventId;
      authority_preimage: Uint8Array;
    }>);

export type Hc2RootRecoveryWorkerResponse =
  | Readonly<{
      request_id: string;
      status: "created";
      kit_bytes: Uint8Array;
      root_public_key_bytes: Uint8Array;
      runtime_ms: number;
    }>
  | Readonly<{
      request_id: string;
      status: "verified";
      root_public_key_bytes: Uint8Array;
      verification_signature: Uint8Array;
      runtime_ms: number;
    }>
  | Readonly<{
      request_id: string;
      status: "signed";
      root_public_key_bytes: Uint8Array;
      signature_bytes: Uint8Array;
      authority_purpose: RootAuthorityPurpose;
      runtime_ms: number;
    }>
  | Readonly<{
      request_id: string;
      status: "rejected";
      runtime_ms: number;
    }>;
