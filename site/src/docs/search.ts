import type { Options, SearchOptions } from 'minisearch';

// One section of a docs page. The intro before the first heading has an empty heading.
export type Section = { id: number; page: string; heading: string; url: string; text: string };

// The build and the browser must use the same options, or the saved index won't load correctly.
export const SEARCH_OPTIONS: Options<Section> = {
	fields: ['page', 'heading', 'text'],
	storeFields: ['page', 'heading', 'url', 'text'],
};

// Typos allowed in a word of the query. Short words have too many close neighbours to allow any.
const typos = (term: string) => (term.length < 5 ? false : term.length < 9 ? 1 : 2);

// Every word must match. Words also match as prefixes, so results appear while a word is half typed.
export const QUERY_OPTIONS: SearchOptions = {
	boost: { heading: 3, page: 2 },
	fuzzy: typos,
	prefix: true,
	combineWith: 'AND',
};
