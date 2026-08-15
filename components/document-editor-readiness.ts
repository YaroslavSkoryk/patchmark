export type DocumentEditorReadinessIdentity = {
  contentFingerprint: string;
  documentKey: string;
  requestGeneration: number;
  switchOperationId: string | null;
};

export type DocumentEditorReadyDetail =
  DocumentEditorReadinessIdentity & {
    mode: "markdown" | "visual";
  };
