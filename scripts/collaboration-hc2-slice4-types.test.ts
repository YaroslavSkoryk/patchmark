import type { ControlGenesisCore } from "../lib/collaboration/control.ts";
import type { PortableBatchMarkerRecord } from "../lib/collaboration/hc2/records.ts";
import type {
  AcceptedCustodyAuthority,
  PreparedDeviceCustodyHandle,
  RootAuthorityPreimage
} from "../lib/collaboration/hc2/custody-types.ts";
import { buildInitialFoundationRootPreimage } from "../lib/collaboration/hc2/custody-types.ts";
import type { Hc2DeviceVaultService } from "../lib/collaboration/hc2/device-vault.ts";
import type { OfflineProjectRootProvider } from "../lib/collaboration/hc2/providers/root-recovery-provider.ts";
import type { Hc2RootRecoveryWorkerRequest } from "../lib/collaboration/hc2/providers/root-recovery-worker-protocol.ts";
import type {
  KeyVault,
  RecoveryCeremonyCapability,
  RootCeremonyCapability,
  SenderSignaturePreimageBytes
} from "../lib/collaboration/hc2/crypto-contracts.ts";
// @ts-expect-error worker-only decrypted payload codec is absent from the HC-2 public barrel.
import { decodeRecoveryKitPayload } from "../lib/collaboration/hc2/index.ts";

declare const genesis: ControlGenesisCore;
declare const root: OfflineProjectRootProvider;
declare const recoveryCapability: RecoveryCeremonyCapability;
declare const rootCapability: RootCeremonyCapability;
declare const typedPreimage: RootAuthorityPreimage;
declare const vault: Hc2DeviceVaultService;
declare const genericVault: KeyVault;
declare const portable: PortableBatchMarkerRecord;

const constructed = buildInitialFoundationRootPreimage(genesis);
void root.signAuthority({
  capability: recoveryCapability,
  recovery_kit_bytes: new Uint8Array(),
  password_material: new Uint8Array(),
  preimage: typedPreimage
});

// @ts-expect-error arbitrary messages are not root-authority preimages.
void root.signAuthority({ capability: recoveryCapability, recovery_kit_bytes: new Uint8Array(), password_material: new Uint8Array(), preimage: new Uint8Array() });
// @ts-expect-error root creation requires the distinct root-ceremony capability.
void root.create({ capability: recoveryCapability, project_id: genesis.project_id, root_key_id: genesis.offline_root_key_id, root_generation: 0n, password_material: new Uint8Array() });
void root.create({ capability: rootCapability, project_id: genesis.project_id, root_key_id: genesis.offline_root_key_id, root_generation: BigInt(0), password_material: new Uint8Array() });

// @ts-expect-error generic vault contract exposes no persisted active-root handle.
void genericVault.loadActiveRootKey(genesis.project_id, genesis.owner_person_id);
// @ts-expect-error device vault exposes no raw epoch-secret getter.
void vault.getEpochSecret(genesis.project_id);
// @ts-expect-error opaque prepared handles cannot be forged from operational facts.
const prepared: PreparedDeviceCustodyHandle = { handle_kind: "prepared_device_custody", project_id: genesis.project_id, device_id: genesis.initial_active_control_device_id };
// @ts-expect-error operational folder observations are not accepted custody authority.
const authority: AcceptedCustodyAuthority = { project_id: genesis.project_id, folder_path: "/tmp/project", permission: "granted" };
// @ts-expect-error raw epoch bytes cannot become a portable batch marker.
const rawEpochInPortable: PortableBatchMarkerRecord = new Uint8Array(32);
// @ts-expect-error raw byte arrays are not branded sender signature preimages.
const senderPreimage: SenderSignaturePreimageBytes = new Uint8Array();

// @ts-expect-error worker root signing requires an exact control-event identity in addition to bytes.
const arbitraryWorkerRequest: Hc2RootRecoveryWorkerRequest = {
  request_id: "a".repeat(32), operation: "sign_root_authority", password: new Uint8Array(),
  project_id: genesis.project_id, root_key_id: genesis.offline_root_key_id,
  kit_bytes: new Uint8Array(), authority_purpose: "root_recovery", authority_preimage: new Uint8Array()
};

void [constructed, prepared, authority, rawEpochInPortable, senderPreimage, arbitraryWorkerRequest, portable, decodeRecoveryKitPayload];
