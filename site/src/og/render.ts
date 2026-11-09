// Draws a page's social image at build time: satori lays out the card as SVG, and sharp turns it into a PNG.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';
import { staticFrame } from '../scripts/logo-ascii';
import type { OgPage } from './pages';
import { HEIGHT, WIDTH } from './size';

const SITE_HOST = 'clue.shivam.dev';

// The colours from src/styles/global.css.
const BG = '#0b0b0b';
const INK = '#ededed';
const INK_SOFT = '#a8a8a8';
const INK_FAINT = '#8a8a8a';
const LOGO_GRADIENT = 'linear-gradient(160deg, #d3e2ff, #82aaff 45%, #5787ea)';

// The logo as ASCII, in the same frame the 404 page settles on. Geist Mono is 0.6em wide, so lines 0.6em tall
// make square cells. At 13px the art is about 375px wide.
const ART_SIZE = 13;

// satori reads woff but not woff2. @fontsource ships static weights as woff. The site uses weights 400 and 600.
const require = createRequire(import.meta.url);
const fontFile = (weight: number) =>
	readFile(require.resolve(`@fontsource/geist-mono/files/geist-mono-latin-${weight}-normal.woff`));

let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 600; style: 'normal' }[]> | undefined;
const loadFonts = () =>
	(fonts ??= Promise.all([fontFile(400), fontFile(600)]).then(([regular, semibold]) => [
		{ name: 'Geist Mono', data: regular, weight: 400, style: 'normal' },
		{ name: 'Geist Mono', data: semibold, weight: 600, style: 'normal' },
	]));

let mark: Promise<string> | undefined;
const loadMark = () =>
	// The build runs from site/, the folder with astro.config.mjs.
	(mark ??= readFile(join(process.cwd(), 'public/favicon.svg')).then(
		(svg) => `data:image/svg+xml;base64,${svg.toString('base64')}`,
	));

// A small stand-in for JSX, so this file needs no JSX setup.
type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): Node => ({
	type,
	props: { style, children, ...props },
});

export async function renderOgImage(page: OgPage): Promise<Buffer> {
	const [fontList, markUri] = await Promise.all([loadFonts(), loadMark()]);
	const url = `${SITE_HOST}${page.path === '/' ? '' : page.path}`;

	const card = h(
		'div',
		{
			// satori adds padding outside a set width, so fill the canvas with border-box instead.
			width: '100%',
			height: '100%',
			boxSizing: 'border-box',
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			padding: '72px 72px 72px 80px',
			background: BG,
			fontFamily: 'Geist Mono',
			fontWeight: 400,
		},
		[
			h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: 600, height: '100%' }, [
				h('div', { display: 'flex', alignItems: 'center', gap: 16 }, [
					h('img', {}, undefined, { src: markUri, width: 44, height: 44 }),
					h('div', { color: INK, fontSize: 30, fontWeight: 600 }, 'clue'),
				]),
				h('div', { display: 'flex', flexDirection: 'column', gap: 24 }, [
					...(page.kicker ? [h('div', { color: INK_FAINT, fontSize: 22 }, page.kicker)] : []),
					h('div', { color: INK, fontSize: page.heading.length > 24 ? 44 : 56, fontWeight: 600, lineHeight: 1.2 }, page.heading),
					h('div', { color: INK_SOFT, fontSize: 22, lineHeight: 1.6, lineClamp: 3 }, page.description),
				]),
				h('div', { color: INK_FAINT, fontSize: 20 }, url),
			]),
			h(
				'div',
				{
					display: 'flex',
					flexShrink: 0,
					fontSize: ART_SIZE,
					lineHeight: 0.6,
					whiteSpace: 'pre',
					backgroundImage: LOGO_GRADIENT,
					backgroundClip: 'text',
					color: 'transparent',
				},
				// satori drops leading spaces even with `pre`, which would shift each line. Non-breaking spaces keep.
				staticFrame().replaceAll(' ', '\u00a0'),
			),
		],
	);

	const svg = await satori(card as Parameters<typeof satori>[0], { width: WIDTH, height: HEIGHT, fonts: fontList });
	return sharp(Buffer.from(svg)).png().toBuffer();
}
