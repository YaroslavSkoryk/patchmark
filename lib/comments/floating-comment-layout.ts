export type FloatingCommentLayoutItem = {
  fallbackHeight: number;
  id: string;
  preferredTop: number;
};

export type FloatingCommentLayoutOptions = {
  gap: number;
  minStageHeight: number;
};

export type FloatingCommentLayoutDiagnostic = {
  calculatedTop: number;
  displacement: number;
  height: number;
  preferredTop: number;
};

export type FloatingCommentLayout = {
  diagnostics: Record<string, FloatingCommentLayoutDiagnostic>;
  positions: Record<string, number>;
  stageHeight: number;
};

type IsotonicBlock = {
  endIndex: number;
  level: number;
  startIndex: number;
  weight: number;
};

export function createFloatingCommentLayout(
  items: FloatingCommentLayoutItem[],
  measuredItemHeights: Record<string, number>,
  { gap, minStageHeight }: FloatingCommentLayoutOptions
): FloatingCommentLayout {
  if (items.length === 0) {
    return {
      diagnostics: {},
      positions: {},
      stageHeight: 0
    };
  }

  const heights = items.map((item) =>
    Math.max(0, measuredItemHeights[item.id] ?? item.fallbackHeight)
  );
  const cumulativeOffsets = getCumulativeLayoutOffsets(heights, gap);
  const targetBaseTops = items.map(
    (item, index) => item.preferredTop - cumulativeOffsets[index]
  );
  const fittedBaseTops = fitNonDecreasingValues(targetBaseTops);
  const rawPositions = fittedBaseTops.map(
    (baseTop, index) => baseTop + cumulativeOffsets[index]
  );
  const minTop = Math.min(...rawPositions);
  const topShift = minTop < 0 ? -minTop : 0;
  const positions: Record<string, number> = {};
  const diagnostics: Record<string, FloatingCommentLayoutDiagnostic> = {};
  let stageBottom = 0;

  for (const [index, item] of items.entries()) {
    const calculatedTop = roundLayoutValue(rawPositions[index] + topShift);
    const height = heights[index];

    positions[item.id] = calculatedTop;
    diagnostics[item.id] = {
      calculatedTop,
      displacement: roundLayoutValue(calculatedTop - item.preferredTop),
      height,
      preferredTop: item.preferredTop
    };
    stageBottom = Math.max(stageBottom, calculatedTop + height);
  }

  return {
    diagnostics,
    positions,
    stageHeight: Math.max(minStageHeight, roundLayoutValue(stageBottom + gap))
  };
}

export function getStageRelativePreferredTop(
  workspaceRelativeTop: number,
  floatingStageOffsetTop: number
): number {
  return Math.max(
    0,
    roundLayoutValue(workspaceRelativeTop - floatingStageOffsetTop)
  );
}

function getCumulativeLayoutOffsets(heights: number[], gap: number): number[] {
  const offsets: number[] = [];
  let nextOffset = 0;

  for (const height of heights) {
    offsets.push(nextOffset);
    nextOffset += height + gap;
  }

  return offsets;
}

function fitNonDecreasingValues(values: number[]): number[] {
  const blocks: IsotonicBlock[] = [];

  for (const [index, value] of values.entries()) {
    blocks.push({
      endIndex: index,
      level: value,
      startIndex: index,
      weight: 1
    });

    while (blocks.length >= 2) {
      const currentBlock = blocks[blocks.length - 1];
      const previousBlock = blocks[blocks.length - 2];

      if (previousBlock.level <= currentBlock.level) {
        break;
      }

      const mergedWeight = previousBlock.weight + currentBlock.weight;
      const mergedLevel =
        (previousBlock.level * previousBlock.weight +
          currentBlock.level * currentBlock.weight) /
        mergedWeight;

      blocks.splice(blocks.length - 2, 2, {
        endIndex: currentBlock.endIndex,
        level: mergedLevel,
        startIndex: previousBlock.startIndex,
        weight: mergedWeight
      });
    }
  }

  const fittedValues = new Array<number>(values.length);

  for (const block of blocks) {
    for (
      let index = block.startIndex;
      index <= block.endIndex;
      index += 1
    ) {
      fittedValues[index] = block.level;
    }
  }

  return fittedValues;
}

function roundLayoutValue(value: number): number {
  return Math.round(value * 100) / 100;
}
