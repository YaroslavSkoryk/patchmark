const ESTIMATED_UTF8_BYTES_PER_TOKEN = 3;

export function estimateCompletePromptTokens(prompt: string): number {
  if (!prompt) {
    return 0;
  }
  return Math.ceil(
    new TextEncoder().encode(prompt).byteLength /
      ESTIMATED_UTF8_BYTES_PER_TOKEN
  );
}
