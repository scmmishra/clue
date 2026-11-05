// Every page that has a social image, and where to find that image.

import { docsDescription } from '../docs/markdown';
import { NAV } from '../docs/nav';
import { CHANGELOG, HOME } from '../site';

export type OgPage = {
	// The page's address, without a trailing slash. The home page is `/`.
	path: string;
	// A small label above the heading, such as `docs`.
	kicker?: string;
	heading: string;
	description: string;
};

export const OG_PAGES: OgPage[] = [
	{ path: '/', heading: HOME.heading, description: HOME.description },
	{ path: '/changelog', heading: CHANGELOG.heading, description: CHANGELOG.description },
	...NAV.flatMap(({ pages }) => pages).map(({ title, slug }) => ({
		path: slug ? `/docs/${slug}` : '/docs',
		kicker: 'docs',
		heading: title,
		description: docsDescription(slug),
	})),
];

const normalize = (path: string) => path.replace(/\/+$/, '') || '/';

// The image's address for a page. `/` becomes /og/index.png and `/docs/tools` becomes /og/docs/tools.png.
export const ogImagePath = (path: string) => `/og${normalize(path) === '/' ? '/index' : normalize(path)}.png`;

// The image for a page. A page without its own image, such as the 404 page, gets the home page's image.
export function ogImageFor(path: string) {
	const page = OG_PAGES.find((candidate) => candidate.path === normalize(path));
	return ogImagePath(page ? page.path : '/');
}
