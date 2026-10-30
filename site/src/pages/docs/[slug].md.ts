import type { APIContext } from 'astro';
import { markdownResponse, markdownSlugs } from '../../docs/markdown';

export const getStaticPaths = () => markdownSlugs.map((slug) => ({ params: { slug } }));

export const GET = ({ params }: APIContext) => markdownResponse(params.slug!);
