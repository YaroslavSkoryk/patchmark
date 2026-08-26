/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- frozen-vector orchestration intentionally parses unbranded JSON input.
import { encodeCanonicalCbor } from "../lib/collaboration/canonical-cbor.ts";
import { canonicalProtocolValue } from "../lib/collaboration/canonical-protocol.ts";
import { parseInvitationHandoffCore } from "../lib/collaboration/hc2/enrollment-contracts.ts";
import {
  buildHc3ConnectionOfferCommitmentPreimage,
  createHc3ConnectionAnswer,
  createHc3ConnectionOffer,
  createHc3HandoffCarrier,
  encodeHc3Carrier
} from "../lib/collaboration/hc3/contracts.ts";
import { createHc3FragmentLink } from "../lib/collaboration/hc3/link.ts";
import { assessHc3SingleQrEligibility } from "../lib/collaboration/hc3/qr.ts";
import { formatHc3ArtifactText } from "../lib/collaboration/hc3/text.ts";

export async function createHc3Slice1VectorActual(fixture) {
  const invitation = parseInvitationHandoffCore(fixture.inputs.invitation_handoff);
  const invitationCarrier = createHc3HandoffCarrier({ artifact_kind: "invitation_handoff", payload: invitation });
  const invitationBytes = encodeHc3Carrier(invitationCarrier);
  const invitationText = formatHc3ArtifactText(invitationCarrier);
  const invitationLink = createHc3FragmentLink({ base_url: fixture.inputs.base_url, artifact_text: invitationText });
  const invitationQr = assessHc3SingleQrEligibility(invitationText);

  const offer = createHc3ConnectionOffer({
    session_id: fixture.inputs.connection.session_id,
    session_generation: BigInt(fixture.inputs.connection.session_generation),
    transport_adapter_tag: hex(fixture.inputs.connection.transport_adapter_tag_hex),
    transport_description_bytes: hex(fixture.inputs.connection.offer_description_hex)
  });
  const offerBytes = encodeHc3Carrier(offer);
  const offerPreimage = buildHc3ConnectionOfferCommitmentPreimage(offer);
  const offerCommitment = new Uint8Array(await crypto.subtle.digest("SHA-256", offerPreimage));
  const offerText = formatHc3ArtifactText(offer);

  const answer = createHc3ConnectionAnswer({
    session_id: fixture.inputs.connection.session_id,
    session_generation: BigInt(fixture.inputs.connection.session_generation),
    transport_adapter_tag: hex(fixture.inputs.connection.transport_adapter_tag_hex),
    transport_description_bytes: hex(fixture.inputs.connection.answer_description_hex),
    offer_commitment_sha256: offerCommitment
  });
  const answerBytes = encodeHc3Carrier(answer);
  const answerText = formatHc3ArtifactText(answer);

  return Object.freeze({
    invitation: Object.freeze({
      hc2_payload_canonical_hex: toHex(encodeCanonicalCbor(canonicalProtocolValue(invitation))),
      carrier_canonical_hex: toHex(invitationBytes),
      carrier_sha256: await sha256Hex(invitationBytes),
      canonical_text: invitationText,
      text_characters: invitationText.length,
      link: invitationLink,
      qr_eligible: invitationQr.eligible
    }),
    connection_offer: Object.freeze({
      carrier_canonical_hex: toHex(offerBytes),
      carrier_sha256: await sha256Hex(offerBytes),
      commitment_preimage_hex: toHex(offerPreimage),
      commitment_sha256: toHex(offerCommitment),
      canonical_text: offerText,
      text_characters: offerText.length,
      qr_eligible: assessHc3SingleQrEligibility(offerText).eligible
    }),
    connection_answer: Object.freeze({
      carrier_canonical_hex: toHex(answerBytes),
      carrier_sha256: await sha256Hex(answerBytes),
      canonical_text: answerText,
      text_characters: answerText.length,
      qr_eligible: assessHc3SingleQrEligibility(answerText).eligible
    })
  });
}

async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function hex(value) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new Error("Vector hex input is invalid.");
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
