// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://clue.shivam.dev',
	integrations: [sitemap()],
	// The pages these replaced were merged, and old links should keep working.
	redirects: {
		'/docs/steer-a-run': '/docs/prompts',
		'/docs/images-and-files': '/docs/prompts',
	},
	// The site reads CHANGELOG.md and package.json from the repository root.
	vite: { server: { fs: { allow: ['..'] } } },
});
