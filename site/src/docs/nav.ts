// The sidebar, in order. Each slug is a file in this folder. An empty slug is /docs. Every page in an
// `experimental` group shows EXPERIMENT_NOTICE.
export const NAV = [
	{
		group: 'getting started',
		pages: [
			{ title: 'Quick start', slug: '' },
		],
	},
	{
		group: 'using clue',
		pages: [
			{ title: 'Prompts', slug: 'prompts' },
			{ title: 'Sessions', slug: 'sessions' },
			{ title: 'Compaction', slug: 'compaction' },
			{ title: 'Scripts', slug: 'scripts' },
		],
	},
	{
		group: 'configure',
		pages: [
			{ title: 'Models', slug: 'models' },
			{ title: 'Permissions', slug: 'permissions' },
			{ title: 'Project instructions', slug: 'project-instructions' },
			{ title: 'Settings', slug: 'settings' },
		],
	},
	{
		group: 'extend',
		pages: [
			{ title: 'Skills', slug: 'skills' },
			{ title: 'MCP servers', slug: 'mcp-servers' },
		],
	},
	{
		group: 'reference',
		pages: [
			{ title: 'Slash commands', slug: 'slash-commands' },
			{ title: 'Keys', slug: 'keys' },
			{ title: 'Tools', slug: 'tools' },
		],
	},
	{
		group: 'experiments',
		experimental: true,
		pages: [
			{ title: 'Dream', slug: 'dream' },
		],
	},
];

export const EXPERIMENT_NOTICE = 'How it works will keep changing, and it may be removed.';

export const isExperiment = (slug: string) =>
	NAV.some((group) => group.experimental && group.pages.some((page) => page.slug === slug));
