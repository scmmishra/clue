// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// The site reads CHANGELOG.md and package.json from the repository root.
	vite: { server: { fs: { allow: ['..'] } } },
});
