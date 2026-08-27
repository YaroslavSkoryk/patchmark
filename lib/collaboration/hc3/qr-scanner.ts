import { parseEligibleHc3QrText, type Hc3QrArtifactKind } from "./qr-provider.ts";

type Detection = Readonly<{ rawValue?: string }>;
type Detector = Readonly<{ detect(source: ImageBitmapSource): Promise<readonly Detection[]> }>;

export type Hc3QrScannerEnvironment = Readonly<{
  document: Document;
  navigator: Navigator;
  request_animation_frame: (callback: FrameRequestCallback) => number;
  cancel_animation_frame: (handle: number) => void;
  create_detector: () => Detector;
  create_video: () => HTMLVideoElement;
}>;

export class Hc3ExplicitQrScanner {
  readonly #environment: Hc3QrScannerEnvironment;
  #frame: number | null = null;
  #stream: MediaStream | null = null;
  #video: HTMLVideoElement | null = null;
  #visibility: (() => void) | null = null;
  #active = false;
  #reject: ((reason: Error) => void) | null = null;

  constructor(environment: Hc3QrScannerEnvironment) {
    this.#environment = environment;
  }

  async scan(input: Readonly<{ artifact_kind: Hc3QrArtifactKind; on_capability(capability: string): void }>): Promise<string> {
    if (this.#active) throw new Error("QR scanning is already active.");
    this.#active = true;
    input.on_capability("Camera with native QR detection");
    try {
      this.#stream = await this.#environment.navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (!this.#active) {
        for (const track of this.#stream.getTracks()) track.stop();
        this.#stream = null;
        throw new Error("QR scan cancelled.");
      }
      this.#video = this.#environment.create_video();
      this.#video.muted = true;
      this.#video.playsInline = true;
      this.#video.srcObject = this.#stream;
      await this.#video.play();
      if (!this.#active) throw new Error("QR scan cancelled.");
      const detector = this.#environment.create_detector();
      this.#visibility = () => { if (this.#environment.document.visibilityState !== "visible") this.cancel(); };
      this.#environment.document.addEventListener("visibilitychange", this.#visibility);
      return await new Promise<string>((resolve, reject) => {
        this.#reject = reject;
        const inspect = async () => {
          if (!this.#active || !this.#video) return;
          try {
            const detections = await detector.detect(this.#video);
            const raw = detections.find((entry) => typeof entry.rawValue === "string" && entry.rawValue.length)?.rawValue;
            if (raw) {
              const parsed = parseEligibleHc3QrText(input.artifact_kind, raw);
              this.#finish();
              resolve(parsed);
              return;
            }
          } catch (error) {
            this.#finish();
            reject(error);
            return;
          }
          this.#frame = this.#environment.request_animation_frame(() => { void inspect(); });
        };
        void inspect();
      });
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  cancel(): void {
    const reject = this.#reject;
    this.#finish();
    reject?.(new Error("QR scan cancelled."));
  }

  #finish(): void {
    this.#active = false;
    this.#reject = null;
    if (this.#frame !== null) this.#environment.cancel_animation_frame(this.#frame);
    this.#frame = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    if (this.#video) this.#video.srcObject = null;
    this.#video = null;
    if (this.#visibility) this.#environment.document.removeEventListener("visibilitychange", this.#visibility);
    this.#visibility = null;
  }
}
