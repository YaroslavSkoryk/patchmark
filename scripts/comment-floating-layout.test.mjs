import assert from "node:assert/strict";
import {
  createFloatingCommentLayout,
  getStageRelativePreferredTop
} from "../lib/comments/floating-comment-layout.ts";

const baseItems = [
  { fallbackHeight: 90, id: "comment-a", preferredTop: 1000 },
  { fallbackHeight: 90, id: "comment-b", preferredTop: 1030 },
  { fallbackHeight: 90, id: "comment-c", preferredTop: 1060 }
];
const options = { gap: 12, minStageHeight: 220 };

function layout(items, heights = {}) {
  return createFloatingCommentLayout(items, heights, options);
}

function positions(items, heights = {}) {
  return layout(items, heights).positions;
}

function assertNoOverlap(items, result, heights = {}) {
  for (let index = 1; index < items.length; index += 1) {
    const previousItem = items[index - 1];
    const currentItem = items[index];
    const previousHeight =
      heights[previousItem.id] ?? previousItem.fallbackHeight;
    const previousBottom = result.positions[previousItem.id] + previousHeight;

    assert.ok(
      result.positions[currentItem.id] >= previousBottom + options.gap,
      `${currentItem.id} should not overlap ${previousItem.id}`
    );
  }
}

{
  const compactPositions = positions(baseItems);
  const activePositions = positions(baseItems, { "comment-b": 320 });
  const collapsedPositions = positions(baseItems);

  assert.deepEqual(collapsedPositions, compactPositions);
  assertNoOverlap(baseItems, layout(baseItems, { "comment-b": 320 }), {
    "comment-b": 320
  });
  assert.equal(Object.keys(activePositions).join(","), "comment-a,comment-b,comment-c");
}

{
  const resolvedCollapsed = positions(baseItems);
  const resolvedExpanded = positions(baseItems, { "comment-a": 260 });
  const resolvedCollapsedAgain = positions(baseItems);

  assert.deepEqual(resolvedCollapsedAgain, resolvedCollapsed);
  assertNoOverlap(baseItems, layout(baseItems, { "comment-a": 260 }), {
    "comment-a": 260
  });
  assert.notEqual(resolvedExpanded["comment-b"], resolvedCollapsed["comment-b"]);
}

{
  const beforeImport = positions(baseItems);
  const afterImport = positions(baseItems, {
    "comment-a": 150,
    "comment-b": 180,
    "comment-c": 140
  });

  assert.deepEqual(positions(baseItems), beforeImport);
  assertNoOverlap(
    baseItems,
    layout(baseItems, {
      "comment-a": 150,
      "comment-b": 180,
      "comment-c": 140
    }),
    {
      "comment-a": 150,
      "comment-b": 180,
      "comment-c": 140
    }
  );
  assert.ok(Number.isFinite(afterImport["comment-b"]));
}

{
  const shiftedItems = baseItems.map((item) => ({
    ...item,
    preferredTop: item.preferredTop + 180
  }));
  const beforePatch = layout(baseItems);
  const afterPatch = layout(shiftedItems);

  assert.equal(
    afterPatch.positions["comment-a"] - beforePatch.positions["comment-a"],
    180
  );
  assert.equal(
    afterPatch.positions["comment-c"] - beforePatch.positions["comment-c"],
    180
  );
}

{
  const tableBefore = [{ fallbackHeight: 120, id: "table-comment", preferredTop: 700 }];
  const tableAfter = [{ fallbackHeight: 120, id: "table-comment", preferredTop: 860 }];

  assert.equal(positions(tableBefore)["table-comment"], 700);
  assert.equal(positions(tableAfter)["table-comment"], 860);
}

{
  assert.equal(getStageRelativePreferredTop(720, 96), 624);
  assert.equal(getStageRelativePreferredTop(40, 96), 0);
}

{
  const firstPass = layout(baseItems, { "comment-b": 320 });
  const secondPass = layout(baseItems, { "comment-b": 320 });

  assert.deepEqual(secondPass, firstPass);
}

{
  const deepItems = baseItems.map((item) => ({
    ...item,
    preferredTop: item.preferredTop + 4000
  }));
  const shallowLayout = layout(baseItems, { "comment-b": 320 });
  const deepLayout = layout(deepItems, { "comment-b": 320 });

  for (const item of baseItems) {
    assert.equal(
      deepLayout.diagnostics[item.id].displacement,
      shallowLayout.diagnostics[item.id].displacement
    );
  }
}

{
  const centeredLayout = layout(baseItems, { "comment-b": 320 });
  const downwardOnlyThirdTop = 1000 + 90 + options.gap + 320 + options.gap;
  const centeredThirdDisplacement =
    centeredLayout.positions["comment-c"] -
    baseItems.find((item) => item.id === "comment-c").preferredTop;
  const downwardOnlyThirdDisplacement =
    downwardOnlyThirdTop -
    baseItems.find((item) => item.id === "comment-c").preferredTop;

  assert.ok(centeredThirdDisplacement < downwardOnlyThirdDisplacement);
}

console.log("Comment floating layout tests passed.");
