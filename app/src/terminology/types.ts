/**
 * Mirrors medblocks-ui's `codedtext/searchFunctions` contract locally so our
 * terminology layer does not import from a Lit 1 package at type level.
 */

export interface SearchOptions {
  searchString: string;
  constraints?: string[];
  maxHits?: number;
  terminology?: string;
}

export interface SearchResult {
  code?: string;
  value?: string;
  text?: string;
  terminology?: string;
}
