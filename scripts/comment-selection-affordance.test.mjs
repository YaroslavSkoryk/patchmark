import assert from "node:assert/strict";
import {
  COMMENT_AFFORDANCE_MENU_SIZE,
  chooseSelectionAffordanceRect,
  createCommentAffordanceBounds,
  createPointAffordanceRect,
  placeCommentAffordance
} from "../lib/comments/comment-selection-affordance.ts";

const menuSize = COMMENT_AFFORDANCE_MENU_SIZE;
const editorBounds = {
  bottom: 700,
  left: 300,
  right: 900,
  top: 100
};

function rect(left, top, right, bottom) {
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left
  };
}

{
  const rightmostCellRect = rect(842, 260, 890, 282);
  const position = placeCommentAffordance({
    anchorRect: rightmostCellRect,
    bounds: editorBounds,
    menuSize
  });

  assert.equal(position.horizontal, "left");
  assert.equal(position.x + menuSize.width <= editorBounds.right, true);
  assert.equal(position.x >= editorBounds.left, true);
}

{
  const middleCellRect = rect(520, 260, 620, 282);
  const position = placeCommentAffordance({
    anchorRect: middleCellRect,
    bounds: editorBounds,
    menuSize
  });

  assert.equal(position.horizontal, "right");
  assert.equal(position.x, middleCellRect.right + 8);
}

{
  const wrappedSelectionRects = [
    rect(610, 300, 880, 320),
    rect(610, 324, 760, 344)
  ];

  assert.deepEqual(
    chooseSelectionAffordanceRect({
      direction: "forward",
      rects: wrappedSelectionRects
    }),
    wrappedSelectionRects[1]
  );
  assert.deepEqual(
    chooseSelectionAffordanceRect({
      direction: "backward",
      rects: wrappedSelectionRects
    }),
    wrappedSelectionRects[0]
  );
}

{
  const rightEdgeRectAfterHorizontalScroll = rect(850, 360, 895, 382);
  const position = placeCommentAffordance({
    anchorRect: rightEdgeRectAfterHorizontalScroll,
    bounds: editorBounds,
    menuSize
  });

  assert.equal(position.horizontal, "left");
  assert.equal(position.x >= editorBounds.left, true);
  assert.equal(position.x + menuSize.width <= editorBounds.right, true);
}

{
  const bottomEdgeRect = rect(560, 660, 620, 684);
  const position = placeCommentAffordance({
    anchorRect: bottomEdgeRect,
    bounds: editorBounds,
    menuSize
  });

  assert.equal(position.vertical, "above");
  assert.equal(position.y >= editorBounds.top, true);
  assert.equal(position.y + menuSize.height <= editorBounds.bottom, true);
}

{
  const constrainedBounds = createCommentAffordanceBounds({
    containerRect: rect(280, 100, 920, 720),
    menuSize,
    viewportHeight: 800,
    viewportWidth: 940
  });
  const sidebarBoundarySelection = rect(880, 220, 918, 242);
  const position = placeCommentAffordance({
    anchorRect: sidebarBoundarySelection,
    bounds: constrainedBounds,
    menuSize
  });

  assert.equal(position.x + menuSize.width <= constrainedBounds.right, true);
  assert.equal(position.x >= constrainedBounds.left, true);
}

{
  const noSelectionPoint = createPointAffordanceRect(895, 240);
  const position = placeCommentAffordance({
    anchorRect: noSelectionPoint,
    bounds: editorBounds,
    menuSize
  });

  assert.equal(position.horizontal, "left");
  assert.equal(position.x + menuSize.width <= editorBounds.right, true);
}

{
  const firstColumnSelection = rect(320, 220, 380, 242);
  const middleColumnSelection = rect(540, 220, 610, 242);
  const rightmostColumnSelection = rect(840, 220, 895, 242);

  for (const anchorRect of [
    firstColumnSelection,
    middleColumnSelection,
    rightmostColumnSelection
  ]) {
    const position = placeCommentAffordance({
      anchorRect,
      bounds: editorBounds,
      menuSize
    });

    assert.equal(position.x >= editorBounds.left, true);
    assert.equal(position.x + menuSize.width <= editorBounds.right, true);
  }
}

console.log("Comment selection affordance tests passed.");
