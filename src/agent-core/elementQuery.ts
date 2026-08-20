/**
 * Element-query extraction helpers shared by the deterministic planner and
 * the server-plan materializer. Kept in a standalone module to avoid the
 * circular dependency that would arise if reasonPlan.ts imported reasoner.ts.
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at", "for",
  "with", "by", "from", "into", "so", "that", "this", "it", "its", "is", "are",
  "was", "be", "been", "as", "via", "all", "my", "their", "our", "your",
  "update", "change", "edit", "fix", "make", "add", "remove", "set", "get",
  "ensure", "check", "verify", "confirm", "enable", "disable",
]);

/**
 * Split a task title on commas and conjunctions, strip stop words from each
 * chunk, and return the first meaningful noun phrase (up to 4 words).
 *
 * "Update the Watch Now, Download Slides and Take The Quiz buttons..."
 *   → "Watch Now"
 */
export const elementQueryFromTitle = (title: string): string | null => {
  // Prefer an explicitly quoted phrase.
  const quoted = title.match(/["'\u201c\u2018\u2019\u201d]([^"'\u201c\u201d\u2018\u2019]{2,60})["'\u201c\u201d\u2018\u2019]/);
  if (quoted) return quoted[1].trim().slice(0, 120);

  const chunks = title
    .replace(/,/g, " | ")
    .split(/\s+[|]\s+|\s+and\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const words = chunk
      .replace(/[^a-z0-9 ]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
    if (words.length >= 1) {
      const phrase = words.slice(0, 4).join(" ").trim();
      if (phrase.length >= 3) return phrase.slice(0, 120);
    }
  }
  return null;
};

/**
 * Up to 3 search terms for a single inspection: one per named element chunk
 * in the title, plus "button" as a last resort. Deduped, bounded to 3.
 */
export const elementQueriesFromTitle = (title: string): string[] => {
  const terms: string[] = [];
  const chunks = title
    .replace(/,/g, " | ")
    .split(/\s+[|]\s+|\s+and\s+/i)
    .map((c) => c.replace(/[^a-z0-9 ]/gi, " ").trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const words = chunk.split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
    const phrase = words.slice(0, 4).join(" ").trim();
    if (phrase.length >= 3 && !terms.includes(phrase)) terms.push(phrase);
    if (terms.length >= 3) break;
  }
  if (!terms.includes("button") && terms.length < 3) terms.push("button");
  return terms.slice(0, 3);
};
