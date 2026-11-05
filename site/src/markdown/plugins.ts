// Markdown plugins for the site, run by Astro's satteri processor. astro.config.mjs lists them.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShikiTransformer } from 'shiki';
import { defineHastPlugin, defineMdastPlugin, type PluginFactoryContext } from 'satteri';

const isDocsPage = (fileURL: URL | undefined) => !!fileURL && fileURL.pathname.includes('/src/docs/');

// Callouts use GitHub's syntax: a blockquote that starts with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or
// [!CAUTION]. It renders as <aside class="callout" data-kind="warning">, and the CSS draws the label. GitHub and the
// .md copies of each page show the same syntax as an alert. Other blockquotes stay as they are.
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;

export const callouts = defineMdastPlugin({
	name: 'callouts',
	blockquote(node, ctx) {
		const paragraph = node.children[0];
		const first = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
		const match = first?.type === 'text' ? first.value.match(CALLOUT) : null;
		if (!first || first.type !== 'text' || !match) return;

		const rest = first.value.slice(match[0].length);
		if (rest) ctx.setProperty(first, 'value', rest);
		else ctx.removeNode(first);
		ctx.setProperty(node, 'data', {
			hName: 'aside',
			hProperties: { className: ['callout'], dataKind: match[1].toLowerCase() },
		});
	},
});

// Inline code that names a key, such as `enter`, `shift+tab`, `ctrl+c` or `esc esc`, renders as <kbd> elements:
// one per key, joined by + within a chord and by a space between chords. Only docs pages, where every such span
// is a key. A single letter or digit counts only after a modifier, so `y` stays code but `ctrl+o` is a key.
const NAMED_KEYS = new Set([
	'enter', 'return', 'esc', 'escape', 'tab', 'space', 'backspace', 'delete',
	'home', 'end', 'pageup', 'pagedown', '↑', '↓', '←', '→',
]);
const MODIFIERS = new Set(['shift', 'ctrl', 'alt', 'option', 'cmd', 'meta', 'super']);

function parseKeys(value: string): string[][] | undefined {
	const chords = value.trim().split(/\s+/).map((chord) => chord.split('+'));
	const valid = chords.every((keys) =>
		keys.every((key, index) => {
			const lower = key.toLowerCase();
			if (index < keys.length - 1) return MODIFIERS.has(lower);
			return NAMED_KEYS.has(lower) || (keys.length > 1 && /^[a-z0-9]$/i.test(key));
		}),
	);
	return valid ? chords : undefined;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const keys = ({ fileURL }: PluginFactoryContext) =>
	isDocsPage(fileURL) &&
	defineMdastPlugin({
		name: 'keys',
		inlineCode(node, ctx) {
			const chords = parseKeys(node.value);
			if (!chords) return;
			const html = chords
				.map((chord) => chord.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join('+'))
				.join(' ');
			ctx.replaceNode(node, { type: 'html', value: `<span class="keys">${html}</span>` });
		},
	});

// A fence can name its file: ```json title="~/.clue/settings.json". Shiki gets the fence's meta, and this keeps
// the title on the <pre> for codeLabels below.
export const codeTitle: ShikiTransformer = {
	name: 'code-title',
	pre(node) {
		const title = this.options.meta?.__raw?.match(/title="([^"]+)"/)?.[1];
		if (title) node.properties.dataTitle = title;
	},
};

// Every code block is wrapped in <div class="code">, which holds the copy button that src/scripts/docs.ts adds.
// The wrapper's data-label is the fence's title, or else its language. The CSS shows it above the code.
const UNLABELLED = new Set(['plaintext', 'text', 'txt', '']);

export const codeLabels = defineHastPlugin({
	name: 'code-labels',
	element: {
		filter: ['pre'],
		visit(node, ctx) {
			const parent = ctx.parent(node);
			if (parent?.type === 'element' && parent.tagName === 'div') return;
			const { dataTitle, dataLanguage } = node.properties ?? {};
			const language = typeof dataLanguage === 'string' ? dataLanguage : '';
			const label = typeof dataTitle === 'string' ? dataTitle : UNLABELLED.has(language) ? undefined : language;
			ctx.wrapNode(node, {
				type: 'element',
				tagName: 'div',
				properties: label ? { className: ['code'], dataLabel: label } : { className: ['code'] },
				children: [],
			});
		},
	},
});

// The date of the last commit that changed a docs page, as frontmatter.lastUpdated, in ISO 8601. In a shallow
// clone the oldest commit looks like it changed every file, so a date from that commit is left out rather than shown
// wrong. Files outside git get no date.
function lastCommitDate(path: string): string | undefined {
	const cwd = dirname(path);
	try {
		const [hash, date] = execFileSync('git', ['log', '-1', '--format=%H %cI', '--', path], { cwd, encoding: 'utf8' })
			.trim()
			.split(' ');
		if (!hash) return undefined;
		const shallowFile = execFileSync('git', ['rev-parse', '--git-path', 'shallow'], { cwd, encoding: 'utf8' }).trim();
		let boundaries = '';
		try {
			boundaries = readFileSync(shallowFile.startsWith('/') ? shallowFile : `${cwd}/${shallowFile}`, 'utf8');
		} catch {
			// Not a shallow clone.
		}
		return boundaries.includes(hash) ? undefined : date;
	} catch {
		return undefined;
	}
}

export const lastUpdated = ({ fileURL }: PluginFactoryContext) =>
	isDocsPage(fileURL) &&
	defineMdastPlugin({
		name: 'last-updated',
		before(_root, ctx) {
			const date = lastCommitDate(fileURLToPath(fileURL!));
			const astro = ctx.data.astro as { frontmatter: Record<string, unknown> } | undefined;
			if (date && astro) astro.frontmatter.lastUpdated = date;
		},
	});
