// /llms-full.txt, every docs page as Markdown in one file, in sidebar order.

import type { APIRoute } from 'astro';
import { pageMarkdown } from '../docs/markdown';
import { NAV } from '../docs/nav';

export const GET: APIRoute = () => {
	const pages = NAV.flatMap(({ pages }) => pages).map(({ slug }) => pageMarkdown(slug).trim());
	return new Response(`${pages.join('\n\n---\n\n')}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
