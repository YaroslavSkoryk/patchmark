export type CommentAffordanceDirection = "backward" | "forward";

export type CommentAffordanceRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

export type CommentAffordanceBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export type CommentAffordancePosition = {
  horizontal: "center" | "left" | "right";
  vertical: "above" | "below" | "clamped";
  x: number;
  y: number;
};

export const COMMENT_AFFORDANCE_MENU_SIZE = {
  height: 176,
  width: 220
};

const DEFAULT_AFFORDANCE_GAP = 8;
const DEFAULT_VIEWPORT_MARGIN = 8;

export function chooseSelectionAffordanceRect({
  direction,
  rects
}: {
  direction: CommentAffordanceDirection;
  rects: CommentAffordanceRect[];
}): CommentAffordanceRect | null {
  const visibleRects = rects.filter(
    (rect) => rect.width > 0 || rect.height > 0
  );

  if (visibleRects.length === 0) {
    return null;
  }

  return direction === "backward"
    ? visibleRects[0]
    : visibleRects[visibleRects.length - 1];
}

export function placeCommentAffordance({
  anchorRect,
  bounds,
  gap = DEFAULT_AFFORDANCE_GAP,
  menuSize = COMMENT_AFFORDANCE_MENU_SIZE
}: {
  anchorRect: CommentAffordanceRect;
  bounds: CommentAffordanceBounds;
  gap?: number;
  menuSize?: { height: number; width: number };
}): CommentAffordancePosition {
  const normalizedBounds = normalizeAffordanceBounds(bounds, menuSize);
  const rightX = anchorRect.right + gap;
  const leftX = anchorRect.left - menuSize.width - gap;
  let horizontal: CommentAffordancePosition["horizontal"] = "right";
  let x = rightX;

  if (rightX + menuSize.width <= normalizedBounds.right) {
    horizontal = "right";
    x = rightX;
  } else if (leftX >= normalizedBounds.left) {
    horizontal = "left";
    x = leftX;
  } else {
    horizontal = "center";
    x = anchorRect.left + anchorRect.width / 2 - menuSize.width / 2;
  }

  const belowY = anchorRect.bottom + gap;
  const aboveY = anchorRect.top - menuSize.height - gap;
  let vertical: CommentAffordancePosition["vertical"] = "below";
  let y = belowY;

  if (belowY + menuSize.height <= normalizedBounds.bottom) {
    vertical = "below";
    y = belowY;
  } else if (aboveY >= normalizedBounds.top) {
    vertical = "above";
    y = aboveY;
  } else {
    vertical = "clamped";
    y = anchorRect.top;
  }

  return {
    horizontal,
    vertical,
    x: clamp(x, normalizedBounds.left, normalizedBounds.right - menuSize.width),
    y: clamp(y, normalizedBounds.top, normalizedBounds.bottom - menuSize.height)
  };
}

export function createCommentAffordanceBounds({
  containerRect,
  menuSize = COMMENT_AFFORDANCE_MENU_SIZE,
  viewportHeight,
  viewportMargin = DEFAULT_VIEWPORT_MARGIN,
  viewportWidth
}: {
  containerRect?: CommentAffordanceRect | null;
  menuSize?: { height: number; width: number };
  viewportHeight: number;
  viewportMargin?: number;
  viewportWidth: number;
}): CommentAffordanceBounds {
  const viewportBounds = {
    bottom: Math.max(viewportMargin, viewportHeight - viewportMargin),
    left: viewportMargin,
    right: Math.max(viewportMargin, viewportWidth - viewportMargin),
    top: viewportMargin
  };

  if (!containerRect) {
    return normalizeAffordanceBounds(viewportBounds, menuSize);
  }

  const containerBounds = {
    bottom: Math.min(viewportBounds.bottom, containerRect.bottom),
    left: Math.max(viewportBounds.left, containerRect.left),
    right: Math.min(viewportBounds.right, containerRect.right),
    top: Math.max(viewportBounds.top, containerRect.top)
  };

  return normalizeAffordanceBounds(containerBounds, menuSize);
}

export function createPointAffordanceRect(
  x: number,
  y: number
): CommentAffordanceRect {
  return {
    bottom: y,
    height: 0,
    left: x,
    right: x,
    top: y,
    width: 0
  };
}

export function toCommentAffordanceRect(
  rect: Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">
): CommentAffordanceRect {
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width
  };
}

function normalizeAffordanceBounds(
  bounds: CommentAffordanceBounds,
  menuSize: { height: number; width: number }
): CommentAffordanceBounds {
  const left = Math.min(bounds.left, bounds.right - menuSize.width);
  const top = Math.min(bounds.top, bounds.bottom - menuSize.height);

  return {
    bottom: Math.max(bounds.bottom, top + menuSize.height),
    left,
    right: Math.max(bounds.right, left + menuSize.width),
    top
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
