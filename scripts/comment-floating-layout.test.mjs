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

function assertPositionsEqual(actual, expected) {
  assert.deepEqual(actual, expected);
}

{
  const compactPositions = positions(baseItems);
  const activePositions = positions(baseItems, { "comment-b": 320 });
  const collapsedPositions = positions(baseItems);

  assertPositionsEqual(compactPositions, {
    "comment-a": 1000,
    "comment-b": 1102,
    "comment-c": 1204
  });
  assertPositionsEqual(activePositions, {
    "comment-a": 1000,
    "comment-b": 1102,
    "comment-c": 1434
  });
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

  assertPositionsEqual(resolvedExpanded, {
    "comment-a": 1000,
    "comment-b": 1272,
    "comment-c": 1374
  });
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
  assert.equal(getStageRelativePreferredTop(40, 96), -56);
  assert.equal(getStageRelativePreferredTop(-120, 96), -216);
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

  assert.equal(centeredLayout.positions["comment-a"], 1000);
  assert.equal(centeredLayout.positions["comment-b"], 1102);
  assert.equal(centeredLayout.positions["comment-c"], downwardOnlyThirdTop);
}

const fiveComments = [
  { fallbackHeight: 80, id: "comment-a", preferredTop: 100 },
  { fallbackHeight: 80, id: "comment-b", preferredTop: 350 },
  { fallbackHeight: 80, id: "comment-c", preferredTop: 700 },
  { fallbackHeight: 80, id: "comment-d", preferredTop: 760 },
  { fallbackHeight: 80, id: "comment-e", preferredTop: 1200 }
];

{
  const compactPositions = positions(fiveComments);
  const activeMiddlePositions = positions(fiveComments, {
    "comment-c": 300
  });

  assertPositionsEqual(compactPositions, {
    "comment-a": 100,
    "comment-b": 350,
    "comment-c": 700,
    "comment-d": 792,
    "comment-e": 1200
  });
  assert.equal(activeMiddlePositions["comment-a"], compactPositions["comment-a"]);
  assert.equal(activeMiddlePositions["comment-b"], compactPositions["comment-b"]);
  assert.equal(activeMiddlePositions["comment-c"], compactPositions["comment-c"]);
  assert.equal(activeMiddlePositions["comment-d"], 1012);
  assert.equal(activeMiddlePositions["comment-e"], compactPositions["comment-e"]);
  assertNoOverlap(fiveComments, layout(fiveComments, { "comment-c": 300 }), {
    "comment-c": 300
  });
}

{
  const compactPositions = positions(fiveComments);
  const activeBottomPositions = positions(fiveComments, {
    "comment-e": 360
  });

  for (const id of ["comment-a", "comment-b", "comment-c", "comment-d"]) {
    assert.equal(activeBottomPositions[id], compactPositions[id]);
  }
  assert.equal(activeBottomPositions["comment-e"], compactPositions["comment-e"]);
}

{
  const compactPositions = positions(fiveComments);
  const activeTopPositions = positions(fiveComments, {
    "comment-a": 300
  });

  assert.equal(activeTopPositions["comment-a"], compactPositions["comment-a"]);
  assert.equal(activeTopPositions["comment-b"], 412);
  assert.equal(activeTopPositions["comment-c"], compactPositions["comment-c"]);
  assert.equal(activeTopPositions["comment-d"], compactPositions["comment-d"]);
  assert.equal(activeTopPositions["comment-e"], compactPositions["comment-e"]);
  assertNoOverlap(fiveComments, layout(fiveComments, { "comment-a": 300 }), {
    "comment-a": 300
  });
}

{
  const compactPositions = positions(fiveComments);
  const activeMiddlePositions = positions(fiveComments, {
    "comment-c": 300
  });

  assert.deepEqual(positions(fiveComments), compactPositions);
  assert.deepEqual(
    positions(fiveComments, {
      "comment-c": 300
    }),
    activeMiddlePositions
  );
  assert.deepEqual(positions(fiveComments), compactPositions);
}

{
  const activeB = positions(fiveComments, { "comment-b": 260 });
  const activeD = positions(fiveComments, { "comment-d": 260 });
  const activeC = positions(fiveComments, { "comment-c": 300 });

  assert.deepEqual(activeB, positions(fiveComments, { "comment-b": 260 }));
  assert.deepEqual(activeD, positions(fiveComments, { "comment-d": 260 }));
  assert.deepEqual(activeC, positions(fiveComments, { "comment-c": 300 }));
  assert.equal(activeD["comment-a"], 100);
  assert.equal(activeD["comment-b"], 350);
  assert.equal(activeD["comment-c"], 700);
}

{
  const compactPositions = positions(fiveComments);
  const longThreadPositions = positions(fiveComments, {
    "comment-c": 800
  });

  assert.equal(longThreadPositions["comment-a"], compactPositions["comment-a"]);
  assert.equal(longThreadPositions["comment-b"], compactPositions["comment-b"]);
  assert.equal(longThreadPositions["comment-c"], compactPositions["comment-c"]);
  assert.equal(longThreadPositions["comment-d"], 1512);
  assert.equal(longThreadPositions["comment-e"], 1604);
  assertNoOverlap(fiveComments, layout(fiveComments, { "comment-c": 800 }), {
    "comment-c": 800
  });
}

{
  const closeAnchors = [
    { fallbackHeight: 90, id: "comment-a", preferredTop: 100 },
    { fallbackHeight: 90, id: "comment-b", preferredTop: 120 },
    { fallbackHeight: 90, id: "comment-c", preferredTop: 140 },
    { fallbackHeight: 90, id: "comment-d", preferredTop: 160 }
  ];
  const compactPositions = positions(closeAnchors);
  const activePositions = positions(closeAnchors, { "comment-c": 260 });

  assertPositionsEqual(compactPositions, {
    "comment-a": 100,
    "comment-b": 202,
    "comment-c": 304,
    "comment-d": 406
  });
  assert.equal(activePositions["comment-a"], compactPositions["comment-a"]);
  assert.equal(activePositions["comment-b"], compactPositions["comment-b"]);
  assert.equal(activePositions["comment-c"], compactPositions["comment-c"]);
  assert.equal(activePositions["comment-d"], 576);
  assertNoOverlap(closeAnchors, layout(closeAnchors, { "comment-c": 260 }), {
    "comment-c": 260
  });
}

{
  const resizedItems = fiveComments.map((item) => ({
    ...item,
    preferredTop: item.preferredTop * 1.25
  }));
  const resizedLayout = layout(resizedItems, { "comment-c": 300 });

  assert.equal(resizedLayout.positions["comment-a"], 125);
  assert.equal(resizedLayout.positions["comment-b"], 437.5);
  assert.equal(resizedLayout.positions["comment-c"], 875);
  assertNoOverlap(resizedItems, resizedLayout, { "comment-c": 300 });
}

console.log("Comment floating layout tests passed.");
