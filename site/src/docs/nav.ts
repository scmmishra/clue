// The sidebar, in order. Each slug is a file in this folder. An empty slug is /docs.
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
];
