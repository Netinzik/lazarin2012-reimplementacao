export function colorGroup(investigation, group) {
  const adjacency = new Map(group.map(id => [id, new Set()]));
  for (const e of investigation.intersections) if (adjacency.has(e.left) && adjacency.has(e.right)) {
    adjacency.get(e.left).add(e.right);
    adjacency.get(e.right).add(e.left);
  }
  const colors = new Map();
  for (const vertex of group) {
    const unavailable = new Set([...adjacency.get(vertex)].map(v => colors.get(v)));
    let color = 0;
    while (unavailable.has(color)) color++;
    colors.set(vertex, color);
  }
  return [...colors];
}

export function extractFeatures(investigation) {
  return investigation.groups.map((group, index) => {
    const color_assignments = colorGroup(investigation, group);
    const colorCount = 1 + Math.max(...color_assignments.map(([, color]) => color));
    const samples = Array.from({ length: colorCount }, (_, color) => {
      const cryptogram_ids = color_assignments.filter(([, c]) => c === color).map(([id]) => id);
      const terms = new Set(cryptogram_ids.flatMap(id => investigation.corpus.cryptogram(id).terms));
      return { color, cryptogram_ids, terms };
    });
    return {
      group_number: index + 1, cryptogram_ids: group, color_assignments, samples,
      colorOf(id) {
        const item = color_assignments.find(([v]) => v === id);
        if (!item) throw new Error('Vértice ausente');
        return item[1];
      }
    };
  });
}
