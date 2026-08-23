export type Hc2RecoveryWorkerRequest = Readonly<{
  request_id: string;
  operation: "protect" | "unlock";
  password: Uint8Array;
  material: Uint8Array;
  salt: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
}>;

export type Hc2RecoveryWorkerResponse =
  | Readonly<{
      request_id: string;
      status: "ok";
      material: Uint8Array;
      runtime_ms: number;
    }>
  | Readonly<{
      request_id: string;
      status: "rejected";
      runtime_ms: number;
    }>;
