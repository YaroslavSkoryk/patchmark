import { decodeString } from "micromark-util-decode-string";

export type TextRange = {
  end: number;
  start: number;
};

export function normalizeMarkdownText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function findExactTextMatches(
  markdown: string,
  searchText: string
): TextRange[] {
  if (!searchText) {
    return [];
  }

  const matches: TextRange[] = [];
  let nextIndex = markdown.indexOf(searchText);

  while (nextIndex !== -1) {
    matches.push({
      end: nextIndex + searchText.length,
      start: nextIndex
    });
    nextIndex = markdown.indexOf(searchText, nextIndex + searchText.length);
  }

  return matches;
}

export function findNormalizedTextMatches(
  text: string,
  searchText: string
): TextRange[] {
  const textIndex = buildNormalizedSourceTextIndex(text);
  const normalizedSearchText = normalizeMarkdownText(searchText);
  const matches: TextRange[] = [];

  if (!normalizedSearchText) {
    return matches;
  }

  let nextIndex = textIndex.text.indexOf(normalizedSearchText);

  while (nextIndex !== -1) {
    const start = textIndex.positions[nextIndex];
    const end = textIndex.ends[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end
      });
    }

    nextIndex = textIndex.text.indexOf(
      normalizedSearchText,
      nextIndex + normalizedSearchText.length
    );
  }

  return matches;
}

export function findMarkdownPlainTextMatches(
  markdown: string,
  searchText: string
): TextRange[] {
  const textIndex = buildMarkdownPlainTextIndex(markdown);
  const normalizedSearchText = normalizeMarkdownText(searchText);
  const matches: TextRange[] = [];

  if (!normalizedSearchText) {
    return matches;
  }

  let nextIndex = textIndex.text.indexOf(normalizedSearchText);

  while (nextIndex !== -1) {
    const start = textIndex.positions[nextIndex];
    const end = textIndex.ends[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end
      });
    }

    nextIndex = textIndex.text.indexOf(
      normalizedSearchText,
      nextIndex + normalizedSearchText.length
    );
  }

  return matches;
}

export function buildMarkdownPlainTextIndex(markdown: string): {
  ends: number[];
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];
  const ends: number[] = [];
  const lines = markdown.split(/(\n)/);
  let markdownOffset = 0;

  for (const lineOrBreak of lines) {
    if (lineOrBreak === "\n") {
      appendNormalizedIndexedCharacter({
        character: " ",
        ends,
        sourceOffset: markdownOffset,
        sourceEnd: markdownOffset + 1,
        positions,
        textParts
      });
      markdownOffset += 1;
      continue;
    }

    const line = lineOrBreak;
    let index = getMarkdownPlainTextLineContentStart(line);

    while (index < line.length) {
      const character = line[index];

      if (
        character === "\\" &&
        isMarkdownEscapablePunctuation(line[index + 1])
      ) {
        appendNormalizedIndexedCharacter({
          character: line[index + 1],
          ends,
          sourceOffset: markdownOffset + index + 1,
          sourceEnd: markdownOffset + index + 2,
          positions,
          textParts
        });
        index += 2;
        continue;
      }

      if (character === "&") {
        const referenceMatch = /^&(?:#(?:\d{1,7}|[xX][\da-fA-F]{1,6})|[\da-zA-Z]{1,31});/.exec(
          line.slice(index)
        );
        const reference = referenceMatch?.[0];
        const decodedReference = reference ? decodeString(reference) : null;

        if (reference && decodedReference && decodedReference !== reference) {
          for (let decodedIndex = 0; decodedIndex < decodedReference.length; decodedIndex += 1) {
            appendNormalizedIndexedCharacter({
              character: decodedReference[decodedIndex],
              ends,
              sourceOffset: markdownOffset + index,
              sourceEnd: markdownOffset + index + reference.length,
              positions,
              textParts
            });
          }
          index += reference.length;
          continue;
        }
      }

      if (character === "(" && index > 0 && line[index - 1] === "]") {
        const closingIndex = line.indexOf(")", index);
        index = closingIndex === -1 ? line.length : closingIndex + 1;
        continue;
      }

      if (character === "_") {
        const runEnd = getDelimiterRunEnd(line, index, "_");

        if (isLiteralUnderscoreRun(line, index, runEnd)) {
          for (let runIndex = index; runIndex < runEnd; runIndex += 1) {
            appendNormalizedIndexedCharacter({
              character: "_",
              ends,
              sourceOffset: markdownOffset + runIndex,
              sourceEnd: markdownOffset + runIndex + 1,
              positions,
              textParts
            });
          }
        }

        index = runEnd;
        continue;
      }

      if (/[*_`\[\]\|\\]/.test(character)) {
        index += 1;
        continue;
      }

      appendNormalizedIndexedCharacter({
        character,
        ends,
        sourceOffset: markdownOffset + index,
        sourceEnd: markdownOffset + index + 1,
        positions,
        textParts
      });
      index += 1;
    }

    markdownOffset += line.length;
  }

  trimNormalizedTextIndex(textParts, positions, ends);

  return {
    ends,
    positions,
    text: textParts.join("")
  };
}

function getMarkdownPlainTextLineContentStart(line: string): number {
  let index = 0;

  while (index < line.length) {
    const prefixMatch = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.exec(
      line.slice(index)
    );

    if (!prefixMatch) {
      break;
    }

    index += prefixMatch[0].length;
  }

  return index;
}

function isMarkdownEscapablePunctuation(character?: string): character is string {
  if (!character) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function getDelimiterRunEnd(
  text: string,
  start: number,
  delimiter: string
): number {
  let end = start + 1;

  while (text[end] === delimiter) {
    end += 1;
  }

  return end;
}

function isLiteralUnderscoreRun(
  text: string,
  start: number,
  end: number
): boolean {
  const before = text[start - 1];
  const after = text[end];
  const leftFlanking = isLeftFlankingDelimiterRun(before, after);
  const rightFlanking = isRightFlankingDelimiterRun(before, after);
  const canOpen =
    leftFlanking && (!rightFlanking || isUnicodePunctuation(before));
  const canClose =
    rightFlanking && (!leftFlanking || isUnicodePunctuation(after));

  return !canOpen && !canClose;
}

function isLeftFlankingDelimiterRun(
  before?: string,
  after?: string
): boolean {
  return Boolean(
    after &&
      !isMarkdownWhitespace(after) &&
      (!isUnicodePunctuation(after) ||
        isMarkdownWhitespace(before) ||
        isUnicodePunctuation(before))
  );
}

function isRightFlankingDelimiterRun(
  before?: string,
  after?: string
): boolean {
  return Boolean(
    before &&
      !isMarkdownWhitespace(before) &&
      (!isUnicodePunctuation(before) ||
        isMarkdownWhitespace(after) ||
        isUnicodePunctuation(after))
  );
}

function isMarkdownWhitespace(character?: string): boolean {
  return character === undefined || /\s/u.test(character);
}

function isUnicodePunctuation(character?: string): boolean {
  return Boolean(character && /[\p{P}\p{S}]/u.test(character));
}

export function getMarkdownPlainText(markdown: string): string {
  return buildMarkdownPlainTextIndex(markdown).text;
}

export function buildNormalizedSourceTextIndex(text: string): {
  ends: number[];
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];
  const ends: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    appendNormalizedIndexedCharacter({
      character: text[index],
      ends,
      sourceOffset: index,
      sourceEnd: index + 1,
      positions,
      textParts
    });
  }

  trimNormalizedTextIndex(textParts, positions, ends);

  return {
    ends,
    positions,
    text: textParts.join("")
  };
}

export function dedupeTextMatches(matches: TextRange[]): TextRange[] {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function appendNormalizedIndexedCharacter({
  character,
  ends,
  positions,
  sourceOffset,
  sourceEnd,
  textParts
}: {
  character: string;
  ends: number[];
  positions: number[];
  sourceOffset: number;
  sourceEnd: number;
  textParts: string[];
}): void {
  const isWhitespace = /\s/.test(character);
  const previousCharacter = textParts[textParts.length - 1];

  if (isWhitespace) {
    if (textParts.length > 0 && previousCharacter !== " ") {
      textParts.push(" ");
      positions.push(sourceOffset);
      ends.push(sourceEnd);
    } else if (previousCharacter === " ") {
      ends[ends.length - 1] = sourceEnd;
    }

    return;
  }

  textParts.push(character);
  positions.push(sourceOffset);
  ends.push(sourceEnd);
}

function trimNormalizedTextIndex(
  textParts: string[],
  positions: number[],
  ends: number[]
): void {
  while (textParts[0] === " ") {
    textParts.shift();
    positions.shift();
    ends.shift();
  }

  while (textParts[textParts.length - 1] === " ") {
    textParts.pop();
    positions.pop();
    ends.pop();
  }
}
