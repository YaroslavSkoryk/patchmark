export type VisualSelectionTextMatch = {
  end: number;
  start: number;
};

export function findUniqueScopedVisualSelectionMatch(
  matches: VisualSelectionTextMatch[],
  scope: VisualSelectionTextMatch
): VisualSelectionTextMatch | null {
  const scopedMatches = matches.filter(
    (match) => match.start >= scope.start && match.end <= scope.end
  );

  return scopedMatches.length === 1 ? scopedMatches[0] : null;
}
