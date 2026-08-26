import { hc2ProtocolLimits } from "../hc2/limits.ts";
import {
  copyPortValue,
  portFailure,
  success,
  type Hc3BrowserPorts,
  type Hc3CapabilityDetectionPort,
  type Hc3ClipboardWritePort,
  type Hc3EncryptedBundleSavePort,
  type Hc3EncryptedBundleSelectionPort,
  type Hc3OsSharePort,
  type Hc3QrPresentationPort,
  type Hc3SafeFileMetadataPort,
  type Hc3SelectedEncryptedFile,
  type Hc3ShareInput,
  type Hc3UserConfirmationPort
} from "./workflow-ports.ts";

type ClipboardLike = Readonly<{ writeText(text: string): Promise<void> }>;
type NavigatorLike = Readonly<{
  clipboard?: ClipboardLike;
  share?: (data: unknown) => Promise<void>;
  canShare?: (data: unknown) => boolean;
}>;

type FileLike = Readonly<{
  size: number;
  type: string;
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type OpenFileHandleLike = Readonly<{ getFile(): Promise<FileLike> }>;
type SaveFileHandleLike = Readonly<{
  createWritable(): Promise<Readonly<{
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?: () => Promise<void>;
  }>>;
}>;

type AnchorLike = { href: string; download: string; rel: string; click(): void; remove(): void };

export type Hc3BrowserAdapterEnvironment = Readonly<{
  is_secure_context: boolean;
  navigator?: NavigatorLike;
  show_open_file_picker?: (options: unknown) => Promise<readonly OpenFileHandleLike[]>;
  show_save_file_picker?: (options: unknown) => Promise<SaveFileHandleLike>;
  create_anchor?: () => AnchorLike;
  create_blob?: (parts: readonly Uint8Array[], options: Readonly<{ type: string }>) => unknown;
  create_file?: (parts: readonly Uint8Array[], filename: string, options: Readonly<{ type: string }>) => unknown;
  create_object_url?: (blob: unknown) => string;
  revoke_object_url?: (url: string) => void;
  confirm?: (message: string) => boolean;
  qr_presenter?: (text: string) => Promise<string>;
}>;

export function createHc3BrowserPorts(environment: Hc3BrowserAdapterEnvironment): Hc3BrowserPorts {
  const env = copyEnvironment(environment);
  return Object.freeze({
    clipboard: createHc3ClipboardAdapter(env),
    qr: createHc3QrPresentationAdapter(env),
    share: createHc3ShareAdapter(env),
    save: createHc3EncryptedBundleSaveAdapter(env),
    select: createHc3EncryptedBundleSelectionAdapter(env),
    metadata: createHc3SafeFileMetadataAdapter(),
    confirmation: createHc3ConfirmationAdapter(env),
    capabilities: createHc3CapabilityDetectionAdapter(env)
  });
}

export function createHc3ClipboardAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3ClipboardWritePort {
  return Object.freeze({
    async writeText(input: Parameters<Hc3ClipboardWritePort["writeText"]>[0]) {
      if (!environment.is_secure_context) return portFailure("unsupported", "clipboard_requires_secure_context", "keep_artifact_for_manual_copy");
      if (!environment.navigator?.clipboard?.writeText) return portFailure("unsupported", "clipboard_unavailable", "keep_artifact_for_manual_copy");
      const text = `${input.text}`;
      try {
        await environment.navigator.clipboard.writeText(text);
        return success(Object.freeze({ written_characters: text.length }));
      } catch (error) {
        return browserFailure(error, "clipboard_write_failed", "keep_artifact_for_manual_copy");
      }
    }
  });
}

export function createHc3QrPresentationAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3QrPresentationPort {
  return Object.freeze({
    async present(input: Parameters<Hc3QrPresentationPort["present"]>[0]) {
      if (!environment.qr_presenter) return portFailure("unsupported", "qr_unavailable", "copy_or_share");
      const text = `${input.text}`;
      try {
        return success(Object.freeze({ presented_text: await environment.qr_presenter(text) }));
      } catch (error) {
        return browserFailure(error, "qr_presentation_failed", "copy_or_share");
      }
    }
  });
}

export function createHc3ShareAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3OsSharePort {
  return Object.freeze({
    async share(input: Parameters<Hc3OsSharePort["share"]>[0]) {
      if (!environment.navigator?.share) return portFailure("unsupported", "share_unavailable", shareFallback(input));
      try {
        if (input.mode === "encrypted_file" && !environment.create_file) {
          return portFailure("unsupported", "encrypted_file_share_unavailable", "save_encrypted_file");
        }
        const data = shareData(input, environment);
        if (input.mode === "encrypted_file" && (!environment.navigator.canShare || !environment.navigator.canShare(data))) {
          return portFailure("unsupported", "encrypted_file_share_unavailable", "save_encrypted_file");
        }
        await environment.navigator.share(copyPortValue(data));
        return success(Object.freeze({ mode: input.mode }));
      } catch (error) {
        return browserFailure(error, "share_failed", shareFallback(input));
      }
    }
  });
}

export function createHc3EncryptedBundleSaveAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3EncryptedBundleSavePort {
  return Object.freeze({
    async save(input: Parameters<Hc3EncryptedBundleSavePort["save"]>[0]) {
      const exact = Uint8Array.from(input.exact_bytes);
      if (environment.show_save_file_picker) {
        let writable: Awaited<ReturnType<SaveFileHandleLike["createWritable"]>> | null = null;
        try {
          const handle = await environment.show_save_file_picker({ suggestedName: input.filename, types: [{ description: "Patchmark encrypted update", accept: { [input.media_type]: [".pmcb"] } }] });
          writable = await handle.createWritable();
          await writable.write(Uint8Array.from(exact));
          await writable.close();
          return success(Object.freeze({ exact_byte_length: BigInt(exact.byteLength) }));
        } catch (error) {
          try { await writable?.abort?.(); } catch { /* best-effort device-private cleanup */ }
          return browserFailure(error, "file_save_failed", "browser_download");
        }
      }
      if (!environment.create_anchor || !environment.create_blob || !environment.create_object_url || !environment.revoke_object_url) {
        return portFailure("unsupported", "file_save_unavailable", null);
      }
      let objectUrl: string | null = null;
      let anchor: AnchorLike | null = null;
      try {
        const blob = environment.create_blob([Uint8Array.from(exact)], { type: input.media_type });
        objectUrl = environment.create_object_url(blob);
        anchor = environment.create_anchor();
        anchor.href = objectUrl;
        anchor.download = input.filename;
        anchor.rel = "noopener";
        anchor.click();
        return success(Object.freeze({ exact_byte_length: BigInt(exact.byteLength) }));
      } catch (error) {
        return browserFailure(error, "download_setup_failed", null);
      } finally {
        try { anchor?.remove(); } finally { if (objectUrl !== null) environment.revoke_object_url(objectUrl); }
      }
    }
  });
}

export function createHc3EncryptedBundleSelectionAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3EncryptedBundleSelectionPort {
  return Object.freeze({
    async select(input: Parameters<Hc3EncryptedBundleSelectionPort["select"]>[0]) {
      if (!environment.show_open_file_picker) return portFailure("unsupported", "file_selection_unavailable", null);
      try {
        const handles = await environment.show_open_file_picker({ multiple: false, types: [{ description: "Patchmark encrypted update", accept: { "application/vnd.patchmark.collaboration-bundle": [".pmcb"] } }] });
        if (handles.length !== 1) return portFailure("cancelled", "file_selection_cancelled", null);
        const file = await handles[0].getFile();
        if (!Number.isSafeInteger(file.size) || file.size <= 0) return portFailure("failed", file.size === 0 ? "empty_file" : "invalid_file_size", null);
        if (BigInt(file.size) > input.maximum_byte_length || BigInt(file.size) > hc2ProtocolLimits.maximum_portable_bundle_canonical_bytes) {
          return portFailure("failed", "oversized_file", null);
        }
        const exact = new Uint8Array(await file.arrayBuffer());
        if (exact.byteLength !== file.size) return portFailure("failed", "file_size_changed_while_reading", null);
        return success(copySelected({
          exact_bytes: exact,
          reported_size: BigInt(file.size),
          media_type_hint: safeHint(file.type, 128),
          extension_hint: extensionHint(file.name)
        }));
      } catch (error) {
        return browserFailure(error, "file_selection_failed", null);
      }
    }
  });
}

export function createHc3SafeFileMetadataAdapter(): Hc3SafeFileMetadataPort {
  return Object.freeze({
    async inspect(input: Parameters<Hc3SafeFileMetadataPort["inspect"]>[0]) {
      try {
        const selected = copySelected(input);
        return success(Object.freeze({
          authority: "none",
          reported_size: selected.reported_size,
          media_type_hint: selected.media_type_hint,
          extension_hint: selected.extension_hint
        }));
      } catch {
        return portFailure("failed", "file_metadata_invalid", null);
      }
    }
  });
}

export function createHc3ConfirmationAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3UserConfirmationPort | null {
  if (!environment.confirm) return null;
  return Object.freeze({
    async confirm(input: Parameters<Hc3UserConfirmationPort["confirm"]>[0]) {
      try {
        return environment.confirm?.(`${input.title}\n\n${input.explanation}`)
          ? success(Object.freeze({ confirmed: true as const }))
          : portFailure("cancelled", "confirmation_cancelled", null);
      } catch (error) {
        return browserFailure(error, "confirmation_failed", null);
      }
    }
  });
}

export function createHc3CapabilityDetectionAdapter(environment: Hc3BrowserAdapterEnvironment): Hc3CapabilityDetectionPort {
  return Object.freeze({
    async detect() {
      try {
        const probeFile = environment.create_file?.([new Uint8Array()], "patchmark.pmcb", { type: "application/vnd.patchmark.collaboration-bundle" });
        const canShareFile = Boolean(probeFile && environment.navigator?.canShare && environment.navigator.canShare({ files: [probeFile] }));
        return success(Object.freeze({
          authority: "none",
          secure_context: environment.is_secure_context,
          clipboard_write: Boolean(environment.is_secure_context && environment.navigator?.clipboard?.writeText),
          text_share: Boolean(environment.navigator?.share),
          encrypted_file_share: canShareFile,
          native_file_save: Boolean(environment.show_save_file_picker),
          native_file_open: Boolean(environment.show_open_file_picker),
          browser_download: Boolean(environment.create_anchor && environment.create_blob && environment.create_object_url && environment.revoke_object_url),
          qr_presentation: Boolean(environment.qr_presenter)
        }));
      } catch (error) {
        return browserFailure(error, "capability_detection_failed", null);
      }
    }
  });
}

function shareData(input: Hc3ShareInput, environment: Hc3BrowserAdapterEnvironment): Readonly<Record<string, unknown>> {
  if (input.mode === "text") return Object.freeze({ title: input.title, text: `${input.text}` });
  if (input.mode === "link") return Object.freeze({ title: input.title, url: input.text });
  const file = environment.create_file?.([Uint8Array.from(input.exact_bytes)], input.filename, { type: input.media_type });
  if (!file) throw new Error("Encrypted-file sharing requires an injected File constructor.");
  return Object.freeze({ title: input.title, files: Object.freeze([file]) });
}

function shareFallback(input: Hc3ShareInput): string {
  return input.mode === "encrypted_file" ? "save_encrypted_file" : "copy_artifact";
}

function browserFailure(error: unknown, fallbackCode: string, fallback: string | null) {
  const name = errorName(error);
  if (name === "AbortError") return portFailure("cancelled", `${fallbackCode}_cancelled`, fallback);
  if (name === "NotAllowedError" || name === "SecurityError") return portFailure("permission_denied", `${fallbackCode}_permission_denied`, fallback);
  return portFailure("failed", fallbackCode, fallback);
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "Error";
}

function safeHint(value: string, maximum: number): string {
  return typeof value === "string" && value.length <= maximum && /^[\x20-\x7e]*$/.test(value) ? value : "";
}

function extensionHint(filename: string): string {
  const safe = safeHint(filename, 255);
  const index = safe.lastIndexOf(".");
  return index < 0 ? "" : safe.slice(index).toLowerCase().slice(0, 16);
}

function copySelected(value: Hc3SelectedEncryptedFile): Hc3SelectedEncryptedFile {
  if (!(value.exact_bytes instanceof Uint8Array) || typeof value.reported_size !== "bigint" || value.reported_size < BigInt(0) ||
      value.reported_size !== BigInt(value.exact_bytes.byteLength)) throw new Error("Selected encrypted file metadata does not match its exact bytes.");
  return Object.freeze({
    exact_bytes: Uint8Array.from(value.exact_bytes),
    reported_size: value.reported_size,
    media_type_hint: safeHint(value.media_type_hint, 128),
    extension_hint: safeHint(value.extension_hint, 16)
  });
}

function copyEnvironment(environment: Hc3BrowserAdapterEnvironment): Hc3BrowserAdapterEnvironment {
  if (!environment || typeof environment.is_secure_context !== "boolean") throw new Error("HC-3 browser adapters require an explicit environment.");
  return Object.freeze({ ...environment });
}
