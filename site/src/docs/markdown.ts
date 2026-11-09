import { EXPERIMENT_NOTICE, isExperiment, NAV } from './nav';

const PAGES = NAV.flatMap(({ pages }) => pages);
const sources = import.meta.glob<string>('./*.md', { eager: true, query: '?raw', import: 'default' });

// The Markdown URL of a page, which is its address plus .md.
export const markdownPath = (slug: string) => (slug ? `/docs/${slug}.md` : '/docs.md');

// A docs page as plain Markdown: its title, the experiment notice if it has one, then the file without the
// frontmatter.
export function pageMarkdown(slug: string) {
	const { title } = PAGES.find((page) => page.slug === slug)!;
	const body = sources[`./${slug || 'quick-start'}.md`].replace(/^---\n[\s\S]*?\n---\n/, '').trim();
	const notice = isExperiment(slug) ? `> **Experiment.** ${EXPERIMENT_NOTICE}\n\n` : '';
	return `# ${title}\n\n${notice}${body}\n`;
}

export const markdownResponse = (slug: string) =>
	new Response(pageMarkdown(slug), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });

// Search engines show about this many characters of a description.
const DESCRIPTION_CHARS = 160;

// A docs page's description, for search results and link previews. In order: the `description` in the
// frontmatter, the paragraph before the first heading, or a line built from the title. A paragraph is cut to the
// whole sentences that fit.
export function docsDescription(slug: string) {
	const source = sources[`./${slug || 'quick-start'}.md`];
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
	const set = frontmatter.match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
	if (set) return set;

	const intro = source.slice(source.indexOf('\n---\n', 4) + 5).split(/^#/m)[0];
	const paragraph = intro.split(/\n\s*\n/).find((block) => /^[A-Za-z`*\[]/.test(block.trim()));
	if (!paragraph) return `${PAGES.find((page) => page.slug === slug)!.title} in the clue docs.`;

	const text = paragraph
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[`*_]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	let description = '';
	// A sentence ends at . ! or ? before a space, so paths such as ~/.clue stay whole.
	for (const sentence of text.split(/(?<=[.!?])\s+/)) {
		if (description && description.length + sentence.length + 1 > DESCRIPTION_CHARS) break;
		description += (description ? ' ' : '') + sentence;
	}
	return description;
}

export const markdownSlugs = PAGES.flatMap(({ slug }) => (slug ? [slug] : []));
