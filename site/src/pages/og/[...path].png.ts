// One social image per page, written at build time. /og/index.png is the home page's.

import type { APIRoute, GetStaticPaths } from 'astro';
import { OG_PAGES, ogImagePath, type OgPage } from '../../og/pages';
import { renderOgImage } from '../../og/render';

export const getStaticPaths: GetStaticPaths = () =>
	OG_PAGES.map((page) => ({
		// ogImagePath gives /og/<path>.png. The route wants only <path>.
		params: { path: ogImagePath(page.path).slice('/og/'.length, -'.png'.length) },
		props: { page },
	}));

export const GET: APIRoute<{ page: OgPage }> = async ({ props }) =>
	new Response(new Uint8Array(await renderOgImage(props.page)), { headers: { 'Content-Type': 'image/png' } });
