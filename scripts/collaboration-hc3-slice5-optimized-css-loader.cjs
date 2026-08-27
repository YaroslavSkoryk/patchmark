"use strict";

module.exports = function patchmarkHc3Slice5OptimizedCssLoader(source) {
  const names = new Set();
  for (const match of source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    names.add(match[1]);
  }
  const mapping = Object.fromEntries([...names].sort().map((name) => [name, name]));
  return `export default Object.freeze(${JSON.stringify(mapping)});`;
};
