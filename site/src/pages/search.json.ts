import MiniSearch from 'minisearch';
import { NAV } from '../docs/nav';
import { SEARCH_OPTIONS, type Section } from '../docs/search';

// The search index, built once at build time as a saved MiniSearch index. Each document is one section of a docs page.
const sources = import.meta.glob<string>('../docs/*.md', { eager: true, query: '?raw', import: 'default' });
const modules = import.meta.glob<{ getHeadings: () => { depth: number; slug: string; text: string }[] }>(
	'../docs/*.md',
	{ eager: true },
);

// Markdown to plain text, close enough for matching and snippets.
const plain = (markdown: string) =>
	markdown
		.replace(/^```.*$/gm, '')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s*\|?\s*-{3}.*$/gm, '')
		.replace(/^>\s?/gm, '')
		.replace(/[`*|#]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

export function GET() {
	const entries = NAV.flatMap(({ pages }) => pages).flatMap(({ title, slug }) => {
		const file = `../docs/${slug || 'quick-start'}.md`;
		const url = slug ? `/docs/${slug}` : '/docs';
		const headings = modules[file].getHeadings().filter(({ depth }) => depth === 2 || depth === 3);
		const body = sources[file].replace(/^---\n[\s\S]*?\n---\n/, '');

		// Split on h2 and h3 lines outside code fences. Headings come back in the same order.
		const sections: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }];
		let fenced = false;
		for (const line of body.split('\n')) {
			if (line.startsWith('```')) fenced = !fenced;
			const match = !fenced && line.match(/^#{2,3}\s+(.*)$/);
			if (match) sections.push({ heading: match[1], lines: [] });
			else sections.at(-1)!.lines.push(line);
		}

		return sections.map(({ heading, lines }, index) => ({
			page: title,
			heading: heading ? plain(heading) : '',
			url: index ? `${url}#${headings[index - 1]?.slug ?? ''}` : url,
			text: plain(lines.join('\n')),
		}));
	});

	const index = new MiniSearch<Section>(SEARCH_OPTIONS);
	index.addAll(entries.map((entry, id) => ({ ...entry, id })));

	return new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } });
}
