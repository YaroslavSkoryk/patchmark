import type { PublicKeyId } from "../lib/collaboration/identities.ts";
import type {
  BoundHpkeAadBytes,
  HpkeCiphertextBytes,
  HpkeEncapsulatedKeyBytes,
  HpkeInfoBytes,
  PublicKeyCodec,
  RandomSource,
  RecipientEnvelopeProvider,
  RecoveryProtector,
  SignatureProvider,
  X25519RecipientKeyPairHandle
} from "../lib/collaboration/hc2/crypto-contracts.ts";
import type { PublicEnvelopeHeader } from "../lib/collaboration/hc2/envelope.ts";
import type { AlgorithmTaggedPublicKeyBytes } from "../lib/collaboration/hc2/crypto-contracts.ts";
import { NativeEd25519SignatureProvider } from "../lib/collaboration/hc2/providers/ed25519-provider.ts";
import { SingleShotHpkeProvider } from "../lib/collaboration/hc2/providers/hpke-provider.ts";
import { Hc2NativeKeyRegistry } from "../lib/collaboration/hc2/providers/native-key-handles.ts";
import { NativePublicKeyCodec } from "../lib/collaboration/hc2/providers/public-key-codec.ts";
import { WorkerRecoveryProtector } from "../lib/collaboration/hc2/providers/recovery-provider.ts";
import { WebCryptoRandomSource } from "../lib/collaboration/hc2/providers/secure-random.ts";

declare const keyId: PublicKeyId;
declare const publicKey: AlgorithmTaggedPublicKeyBytes;
declare const recipient: X25519RecipientKeyPairHandle;
declare const info: HpkeInfoBytes;
declare const boundAad: BoundHpkeAadBytes;
declare const enc: HpkeEncapsulatedKeyBytes;
declare const ciphertext: HpkeCiphertextBytes;
declare const publicHeader: PublicEnvelopeHeader;

const registry = new Hc2NativeKeyRegistry();
const random: RandomSource = new WebCryptoRandomSource();
const signatures: SignatureProvider = new NativeEd25519SignatureProvider(registry);
const hpke: RecipientEnvelopeProvider = new SingleShotHpkeProvider({ keys: registry });
const recovery: RecoveryProtector = new WorkerRecoveryProtector({ random });
const codec: PublicKeyCodec = new NativePublicKeyCodec(crypto.subtle);

void registry.generateDeviceSigningKey(keyId);
void registry.generateRecipientKeyPair(keyId);
void hpke.sealBound({ recipient_public_key: publicKey, info, plaintext: new Uint8Array(), finalize_aad: (value: HpkeEncapsulatedKeyBytes) => (void value, boundAad) });
void hpke.openBound({ recipient_key_pair: recipient, info, public_header: publicHeader, ciphertext_bytes: ciphertext });

// @ts-expect-error callers cannot inject an HPKE nonce.
void hpke.sealBound({ recipient_public_key: publicKey, info, plaintext: new Uint8Array(), finalize_aad: () => boundAad, nonce: new Uint8Array(12) });
// @ts-expect-error the API exposes no reusable sender context.
void hpke.createSenderContext({ recipient_public_key: publicKey });
// @ts-expect-error a private-only handle is not an opaque complete keypair handle.
void hpke.openBound({ recipient_key_pair: recipient.private_key, info, public_header: publicHeader, ciphertext_bytes: ciphertext });
// @ts-expect-error arbitrary unbranded AAD cannot be returned by the finalizer.
void hpke.sealBound({ recipient_public_key: publicKey, info, plaintext: new Uint8Array(), finalize_aad: () => new Uint8Array() });
// @ts-expect-error asynchronous AAD finalizers are forbidden.
void hpke.sealBound({ recipient_public_key: publicKey, info, plaintext: new Uint8Array(), finalize_aad: async () => boundAad });
// @ts-expect-error opening accepts no independently supplied enc or AAD.
void hpke.openBound({ recipient_key_pair: recipient, info, public_header: publicHeader, ciphertext_bytes: ciphertext, encapsulated_key_bytes: enc, aad: boundAad });
// @ts-expect-error completed results expose bytes, never a second seal operation.
void hpke.sealBound({ recipient_public_key: publicKey, info, plaintext: new Uint8Array(), finalize_aad: () => boundAad }).then((result) => result.seal(new Uint8Array()));
// @ts-expect-error random lengths cannot be caller strings.
void random.randomBytes("32");
// @ts-expect-error recovery protection requires a ceremony-scoped branded capability.
void recovery.protect({ capability: { scope: "root_ceremony_only", person_id: "person" }, recovery_payload: new Uint8Array(), password_material: new Uint8Array() });
// @ts-expect-error signatures require a branded domain-separated preimage.
void signatures.sign({ key: recipient.private_key, preimage: new Uint8Array() });

void [signatures, recovery, codec];
