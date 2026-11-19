import { sortTerms } from './terms.js';

export function preprocess(input) {
  const cryptograms = [...input];
  const byId = new Map(cryptograms.map(c => [c.identifier, c]));
  if (byId.size !== cryptograms.length) throw new Error('Identificadores devem ser únicos');
  const terms = new Set(), occurrences = [];
  for (const c of cryptograms) {
    for (const term of sortTerms(new Set(c.terms))) {
      terms.add(term);
      occurrences.push({ cryptogram_id: c.identifier, term });
    }
  }
  return {
    cryptograms, terms, occurrences, ordered_ids: [...byId.keys()],
    cryptogram(id) {
      if (!byId.has(id)) throw new Error('Criptograma ausente: ' + id);
      return byId.get(id);
    }
  };
}

export function findIntersections(corpus) {
  const result = [];
  const sets = corpus.cryptograms.map(c => new Set(c.terms));
  const postings = new Map();
  for (let index = 0; index < sets.length; index++) {
    for (const term of sets[index]) {
      const previous = postings.get(term);
      if (previous === undefined) postings.set(term, index);
      else if (typeof previous === 'number') postings.set(term, [previous, index]);
      else previous.push(index);
    }
  }
  for (let i = 0; i < sets.length; i++) {
    const commonByRight = new Map();
    for (const term of sets[i]) {
      const members = postings.get(term);
      if (typeof members === 'number') continue;
      for (const j of members) {
        if (j <= i) continue;
        if (!commonByRight.has(j)) commonByRight.set(j, new Set());
        commonByRight.get(j).add(term);
      }
    }
    for (const j of [...commonByRight.keys()].sort((a, b) => a - b)) {
      result.push({
        left: corpus.ordered_ids[i], right: corpus.ordered_ids[j],
        common_terms: commonByRight.get(j)
      });
    }
  }
  return result;
}

export function groupIntersections(corpus, intersections) {
  const adjacency = new Map(corpus.ordered_ids.map(id => [id, new Set()]));
  for (const edge of intersections) {
    if (!adjacency.has(edge.left) || !adjacency.has(edge.right)) throw new Error('Vértice ausente de C');
    adjacency.get(edge.left).add(edge.right);
    adjacency.get(edge.right).add(edge.left);
  }
  const ungrouped = corpus.ordered_ids.filter(id => !adjacency.get(id).size);
  const visited = new Set(ungrouped), groups = [];
  for (const root of corpus.ordered_ids) {
    if (visited.has(root)) continue;
    const stack = [root], component = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);
      for (const neighbor of adjacency.get(current)) if (!visited.has(neighbor)) stack.push(neighbor);
    }
    groups.push(corpus.ordered_ids.filter(id => component.has(id)));
  }
  return { ungrouped, groups };
}

export function investigate(cryptograms) {
  const corpus = preprocess(cryptograms);
  const intersections = findIntersections(corpus);
  return { corpus, intersections, ...groupIntersections(corpus, intersections) };
}
