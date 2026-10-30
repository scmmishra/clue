import { NAV } from './nav';

const PAGES = NAV.flatMap(({ pages }) => pages);
const sources = import.meta.glob<string>('./*.md', { eager: true, query: '?raw', import: 'default' });

// The Markdown URL of a page, which is its address plus .md.
export const markdownPath = (slug: string) => (slug ? `/docs/${slug}.md` : '/docs.md');

// A docs page as plain Markdown: its title, then the file without the frontmatter.
export function markdownResponse(slug: string) {
	const { title } = PAGES.find((page) => page.slug === slug)!;
	const body = sources[`./${slug || 'quick-start'}.md`].replace(/^---\n[\s\S]*?\n---\n/, '').trim();
	return new Response(`# ${title}\n\n${body}\n`, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}

export const markdownSlugs = PAGES.flatMap(({ slug }) => (slug ? [slug] : []));
