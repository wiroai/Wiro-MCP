import type { ToolListResponse } from '../types.js';

/**
 * Tool/List with `searchfallback` answers a search that no model matches in
 * full with the results for the longest run of its words that some model has.
 * It names that run (`searchused`, empty when no run matched) and the words the
 * results leave out (`searchignored`). Both are absent when every word matched,
 * and on an API without the fallback.
 */
export interface SearchFallback {
  used: string;
  ignored: string[];
}

export const SEARCH_WORDS_HINT = 'Search by the task or the model name, such as "text to image" or "upscale image"; '
  + 'style and subject words belong in the prompt.';

export function readSearchFallback(result: ToolListResponse): SearchFallback | null {
  const ignored = Array.isArray(result.searchignored)
    ? result.searchignored
      .filter((word): word is string => typeof word === 'string')
      .map(word => word.trim())
      .filter(word => word.length > 0)
    : [];
  if (!ignored.length) return null;
  const used = typeof result.searchused === 'string' ? result.searchused.trim() : '';
  return { used, ignored };
}

function quoted(words: string[]): string {
  return words.map(word => `"${word}"`).join(', ');
}

/** The line put above results that are for only part of the search, or none of it. */
export function partialSearchNote(search: string, fallback: SearchFallback): string {
  const lead = fallback.used
    ? `No model matched every word of "${search}", so these results are for "${fallback.used}" (left out: ${quoted(fallback.ignored)}).`
    : `No model has ${quoted(fallback.ignored)}, so these results leave the search out.`;
  return `${lead} Style and subject words belong in the prompt, not the search.`;
}

/** The sentence added to an empty result when the API named the words no model has. */
export function missingWordsNote(fallback: SearchFallback): string {
  return `No model has ${quoted(fallback.ignored)}.`;
}

/** The structured fields a model list carries when the results leave words out. */
export function searchFallbackFields(fallback: SearchFallback | null): { searchUsed?: string; ignoredWords?: string[] } {
  if (!fallback) return {};
  return {
    ...(fallback.used ? { searchUsed: fallback.used } : {}),
    ignoredWords: fallback.ignored,
  };
}
