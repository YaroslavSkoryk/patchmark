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
  const positions: Record<string, number> = {};
  const diagnostics: Record<string, FloatingCommentLayoutDiagnostic> = {};
  let stageBottom = 0;
  let previousBottom = 0;

  for (const [index, item] of items.entries()) {
    const height = heights[index];
    const minimumTop = index === 0 ? 0 : previousBottom + gap;
    const calculatedTop = roundLayoutValue(
      Math.max(0, item.preferredTop, minimumTop)
    );

    positions[item.id] = calculatedTop;
    diagnostics[item.id] = {
      calculatedTop,
      displacement: roundLayoutValue(calculatedTop - item.preferredTop),
      height,
      preferredTop: item.preferredTop
    };
    previousBottom = calculatedTop + height;
    stageBottom = Math.max(stageBottom, previousBottom);
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
  return roundLayoutValue(workspaceRelativeTop - floatingStageOffsetTop);
}

export function getWorkspaceRelativePreferredTop(
  anchorViewportTop: number,
  workspaceViewportTop: number
): number {
  return Math.max(
    0,
    roundLayoutValue(anchorViewportTop - workspaceViewportTop)
  );
}

function roundLayoutValue(value: number): number {
  return Math.round(value * 100) / 100;
}
