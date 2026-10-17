// The palette's matcher and ranking. Grove's overlays only filtered by substrings (every word
// of the query somewhere in the text); this keeps that rule, so a query that matched there still
// matches, and widens it to letters in order ("tgsb" finds "Toggle sidebar") with a score, so
// the closest match comes first. Pure functions.

export interface Searchable {
  title: string;
  /** The group, keywords or anything else worth matching but less than the title. */
  extra?: string;
}

/** Whether the character at `index` starts a word: the first one, or after a space, dot, dash or slash. */
function startsWord(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return " .-_/:".includes(text[index - 1]);
}

/** The score of a term found as one run of characters. */
function scoreRun(text: string, term: string, index: number): number {
  let score = 100 - index * 0.5 - (text.length - term.length) * 0.1;
  if (index === 0) {
    score += 30;
  } else if (startsWord(text, index)) {
    score += 20;
  }
  return score;
}

/** The score of a term whose letters appear in order but apart, or null when they do not. */
function scoreScattered(text: string, term: string): number | null {
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of term) {
    const found = text.indexOf(letter, from);
    if (found < 0) {
      return null;
    }
    score += 10;
    if (found === previous + 1) {
      score += 8;
    }
    if (startsWord(text, found)) {
      score += 6;
    }
    score -= Math.min(found - from, 6);
    previous = found;
    from = found + 1;
  }
  // Stays under any run: a scattered match never outranks the same word typed in full.
  return Math.min(score, 60);
}

/** How well one query word matches the text, or null when it does not. */
function scoreTerm(text: string, term: string): number | null {
  const index = text.indexOf(term);
  if (index >= 0) {
    return scoreRun(text, term, index);
  }
  return scoreScattered(text, term);
}

/** The score of the whole query against a text: every word must match. Higher is better. */
function scoreQuery(text: string, terms: string[]): number | null {
  let total = 0;
  for (const term of terms) {
    const score = scoreTerm(text, term);
    if (score === null) {
      return null;
    }
    total += score;
  }
  return total;
}

/** How well the query matches an item, or null when it does not match at all. Title matches count double. */
export function matchScore(query: string, item: Searchable): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return 0;
  }
  const title = item.title.toLowerCase();
  const titleScore = scoreQuery(title, terms);
  if (titleScore !== null) {
    return titleScore * 2;
  }
  let extra = "";
  if (item.extra !== undefined) {
    extra = item.extra.toLowerCase();
  }
  return scoreQuery(`${title} ${extra}`, terms);
}

/** The items that match, best first; equal scores keep their order. With no query, every item in its own order. */
export function rankItems<T extends Searchable>(items: T[], query: string): T[] {
  if (query.trim() === "") {
    return items;
  }
  const scored: { item: T; score: number; position: number }[] = [];
  items.forEach((item, position) => {
    const score = matchScore(query, item);
    if (score !== null) {
      scored.push({ item, score, position });
    }
  });
  scored.sort((first, second) => second.score - first.score || first.position - second.position);
  return scored.map((entry) => entry.item);
}
