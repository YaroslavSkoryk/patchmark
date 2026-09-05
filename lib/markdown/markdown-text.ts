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
    const end = textIndex.positions[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end: end + 1
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
    const end = textIndex.positions[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end: end + 1
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
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];
  const lines = markdown.split(/(\n)/);
  let markdownOffset = 0;

  for (const lineOrBreak of lines) {
    if (lineOrBreak === "\n") {
      appendNormalizedIndexedCharacter({
        character: " ",
        sourceOffset: markdownOffset,
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
          sourceOffset: markdownOffset + index + 1,
          positions,
          textParts
        });
        index += 2;
        continue;
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
              sourceOffset: markdownOffset + runIndex,
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
        sourceOffset: markdownOffset + index,
        positions,
        textParts
      });
      index += 1;
    }

    markdownOffset += line.length;
  }

  trimNormalizedTextIndex(textParts, positions);

  return {
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
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    appendNormalizedIndexedCharacter({
      character: text[index],
      sourceOffset: index,
      positions,
      textParts
    });
  }

  trimNormalizedTextIndex(textParts, positions);

  return {
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
  positions,
  sourceOffset,
  textParts
}: {
  character: string;
  positions: number[];
  sourceOffset: number;
  textParts: string[];
}): void {
  const isWhitespace = /\s/.test(character);
  const previousCharacter = textParts[textParts.length - 1];

  if (isWhitespace) {
    if (textParts.length > 0 && previousCharacter !== " ") {
      textParts.push(" ");
      positions.push(sourceOffset);
    }

    return;
  }

  textParts.push(character);
  positions.push(sourceOffset);
}

function trimNormalizedTextIndex(
  textParts: string[],
  positions: number[]
): void {
  while (textParts[0] === " ") {
    textParts.shift();
    positions.shift();
  }

  while (textParts[textParts.length - 1] === " ") {
    textParts.pop();
    positions.pop();
  }
}
