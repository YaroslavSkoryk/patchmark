import type {
  AcceptedControlStateSignerKeyResolver,
  AcceptedSignerPublicKey,
  DeviceSigningPrivateKeyHandle,
  DeviceStreamState,
  DeviceStreamCoordinationStore,
  DeviceStreamObjectId,
  EnvelopeAadBytes,
  HpkeInfoBytes,
  RecipientEnvelopeProvider,
  SenderSignaturePreimageBytes,
  SignatureProvider,
  Hc2DevicePrivateAuthoritativeState,
  Hc2DevicePrivateOperationalState,
  X25519RecipientKeyPairHandle,
  X25519RecipientPrivateKeyHandle
} from "../lib/collaboration/hc2/index.ts";
import {
  assertPortableRecordKind,
  hc2ObjectAddresses,
  parseHc2DevicePrivateAuthoritativeState,
  parseHc2DevicePrivateOperationalState
} from "../lib/collaboration/hc2/index.ts";
import type {
  ControlEventId,
  DeviceId,
  DocumentRevisionId,
  MarkdownBlobId,
  ProjectId,
  PublicKeyId
} from "../lib/collaboration/index.ts";

declare const projectId: ProjectId;
declare const deviceId: DeviceId;
declare const publicKeyId: PublicKeyId;
declare const controlHeadId: ControlEventId;
declare const markdownId: MarkdownBlobId;
declare const revisionId: DocumentRevisionId;
declare const signingHandle: DeviceSigningPrivateKeyHandle;
declare const recipientHandle: X25519RecipientPrivateKeyHandle;
declare const recipientPairHandle: X25519RecipientKeyPairHandle;
declare const acceptedSigner: AcceptedSignerPublicKey;
declare const signaturePreimage: SenderSignaturePreimageBytes;
declare const hpkeInfo: HpkeInfoBytes;
declare const aad: EnvelopeAadBytes;
declare const signatureProvider: SignatureProvider;
declare const recipientProvider: RecipientEnvelopeProvider;
declare const resolver: AcceptedControlStateSignerKeyResolver;
declare const coordination: DeviceStreamCoordinationStore;
declare const streamObject: DeviceStreamObjectId;
declare const authoritativeDeviceState: Hc2DevicePrivateAuthoritativeState;
declare const operationalDeviceState: Hc2DevicePrivateOperationalState;

void hc2ObjectAddresses("markdown-blob", markdownId);
void hc2ObjectAddresses("document-revision", revisionId);
assertPortableRecordKind("markdown_blob");
void signatureProvider.sign({ key: signingHandle, preimage: signaturePreimage });
void signatureProvider.verify({ signer: acceptedSigner, preimage: signaturePreimage, signature_bytes: new Uint8Array(64) });
void recipientProvider.open({
  recipient_key_pair: recipientPairHandle,
  info: hpkeInfo,
  aad,
  encapsulated_key_bytes: new Uint8Array(32),
  ciphertext: new Uint8Array(32)
});
void resolver.resolve({
  project_id: projectId,
  sender_device_id: deviceId,
  asserted_key_id: publicKeyId,
  accepted_control_head_id: controlHeadId
});
void coordination;
void streamObject;
void parseHc2DevicePrivateAuthoritativeState({
  classification_version: 1,
  record_kind: "device_signing_key_handle",
  authority: "device_private_authoritative"
});
void parseHc2DevicePrivateOperationalState({
  classification_version: 1,
  record_kind: "browser_directory_handle",
  authority: "device_private_operational"
});

// @ts-expect-error Revision identities cannot address Markdown objects.
hc2ObjectAddresses("markdown-blob", revisionId);
// @ts-expect-error Device-private key records cannot satisfy a portable record-kind assertion.
assertPortableRecordKind("device_private_key_handle");
// @ts-expect-error Folder handles are operational and cannot satisfy an authoritative device-state contract.
const folderAuthority: Hc2DevicePrivateAuthoritativeState = operationalDeviceState;
// @ts-expect-error Key-handle/continuity authority cannot satisfy an operational state contract.
const keyHandleOperation: Hc2DevicePrivateOperationalState = authoritativeDeviceState;
// @ts-expect-error Permission/path observations cannot satisfy a key-vault signing-handle contract.
const signingKeyFromPath: DeviceSigningPrivateKeyHandle = operationalDeviceState;
// @ts-expect-error Permission/path observations cannot satisfy device stream continuity.
const sequenceContinuityFromPermission: DeviceStreamState = operationalDeviceState;
void folderAuthority;
void keyHandleOperation;
void signingKeyFromPath;
void sequenceContinuityFromPermission;
// @ts-expect-error A recipient private-key handle cannot sign.
signatureProvider.sign({ key: recipientHandle, preimage: signaturePreimage });
// @ts-expect-error Signature verification requires accepted-control resolution, not an inline key ID.
signatureProvider.verify({ signer: publicKeyId, preimage: signaturePreimage, signature_bytes: new Uint8Array(64) });
// @ts-expect-error HPKE info cannot be replaced by generic bytes.
recipientProvider.open({ recipient_key_pair: recipientPairHandle, info: new Uint8Array(), aad, encapsulated_key_bytes: new Uint8Array(), ciphertext: new Uint8Array() });
// @ts-expect-error AAD cannot be replaced by HPKE info.
recipientProvider.open({ recipient_key_pair: recipientPairHandle, info: hpkeInfo, aad: hpkeInfo, encapsulated_key_bytes: new Uint8Array(), ciphertext: new Uint8Array() });
