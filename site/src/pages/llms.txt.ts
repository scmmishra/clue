// /llms.txt, the index of the docs for language models. The format is described at https://llmstxt.org.

import type { APIRoute } from 'astro';
import { docsDescription, markdownPath } from '../docs/markdown';
import { NAV } from '../docs/nav';
import { CHANGELOG, HOME } from '../site';

export const GET: APIRoute = ({ site }) => {
	const url = (path: string) => new URL(path, site).href;
	const sections = NAV.map(
		({ group, pages }) =>
			`## ${group[0].toUpperCase()}${group.slice(1)}\n\n` +
			pages.map(({ title, slug }) => `- [${title}](${url(markdownPath(slug))}): ${docsDescription(slug)}`).join('\n'),
	);
	const text = [
		'# clue',
		`> ${HOME.description}`,
		`Each page below is plain Markdown. All of them together are at ${url('/llms-full.txt')}.`,
		...sections,
		`## Optional\n\n- [${CHANGELOG.heading}](${url('/changelog')}): ${CHANGELOG.description}`,
	].join('\n\n');
	return new Response(`${text}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
