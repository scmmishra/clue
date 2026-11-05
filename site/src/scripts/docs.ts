// Behaviour for docs pages: copy buttons, heading anchors, the mobile menu, the table of contents and search.

import type MiniSearch from 'minisearch';
import { QUERY_OPTIONS, SEARCH_OPTIONS, type Section } from '../docs/search';

const COPIED_MS = 1500;
const MAX_RESULTS = 8;
const SNIPPET_CHARS = 140;

const article = document.querySelector<HTMLElement>('.prose')!;

// Shows `copied` on a button for a moment.
function flash(button: HTMLButtonElement, label: string) {
	// Keep the width, so the shorter label doesn't move the button's edge.
	button.style.minWidth = `${button.offsetWidth}px`;
	button.textContent = 'copied';
	button.dataset.copied = '';
	clearTimeout(Number(button.dataset.reset));
	button.dataset.reset = String(
		window.setTimeout(() => {
			button.textContent = label;
			delete button.dataset.copied;
		}, COPIED_MS),
	);
}

// The page as Markdown. If the browser refuses the clipboard, open the Markdown instead.
const markdownButton = document.querySelector<HTMLButtonElement>('[data-markdown-link]')!;
markdownButton.addEventListener('click', async () => {
	const link = new URL(markdownButton.dataset.markdownLink!, location.origin).href;
	try {
		await navigator.clipboard.writeText(link);
	} catch {
		location.href = link;
		return;
	}
	flash(markdownButton, 'copy markdown link');
});

// Code blocks get a copy button. If the clipboard is refused, select the code so it can be copied by hand.
// The build wraps each block in <div class="code">; see src/markdown/plugins.ts.
for (const pre of article.querySelectorAll('pre')) {
	let wrap = pre.parentElement!;
	if (!wrap.classList.contains('code')) {
		wrap = document.createElement('div');
		wrap.className = 'code';
		pre.replaceWith(wrap);
		wrap.append(pre);
	}

	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'code-copy';
	button.textContent = 'copy';
	button.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(pre.innerText.trimEnd());
		} catch {
			getSelection()?.selectAllChildren(pre);
			return;
		}
		flash(button, 'copy');
	});
	wrap.append(button);
}

// Headings get a `#` link to themselves.
for (const heading of article.querySelectorAll<HTMLElement>('h2[id], h3[id]')) {
	const anchor = document.createElement('a');
	anchor.className = 'anchor';
	anchor.href = `#${heading.id}`;
	anchor.textContent = '#';
	anchor.setAttribute('aria-label', `Link to ${heading.textContent}`);
	heading.append(anchor);
}

// On narrow screens the sidebar collapses behind a button. Without JavaScript it stays open.
const menu = document.querySelector<HTMLButtonElement>('.docs-menu')!;
menu.hidden = false;
menu.addEventListener('click', () => {
	menu.setAttribute('aria-expanded', String(menu.getAttribute('aria-expanded') !== 'true'));
});

// The table of contents marks the last section whose heading has scrolled past the top third of the screen.
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('.toc a')];
const tocTargets = tocLinks.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))));
if (tocLinks.length) {
	let frame = 0;
	const update = () => {
		frame = 0;
		const line = innerHeight / 3;
		let active = -1;
		tocTargets.forEach((target, index) => {
			if (target && target.getBoundingClientRect().top < line) active = index;
		});
		// At the bottom of the page, the last section is current even if its heading can't reach the line.
		if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) active = tocLinks.length - 1;
		tocLinks.forEach((link, index) => {
			if (index === active) link.setAttribute('aria-current', 'true');
			else link.removeAttribute('aria-current');
		});
	};
	addEventListener('scroll', () => (frame ||= requestAnimationFrame(update)), { passive: true });
	addEventListener('resize', () => (frame ||= requestAnimationFrame(update)));
	update();
}

// Search. The MiniSearch index is built at build time. The library and the index load the first time search opens.

const dialog = document.querySelector<HTMLDialogElement>('dialog.search')!;
const input = dialog.querySelector('input')!;
const list = dialog.querySelector('ul')!;
const empty = dialog.querySelector<HTMLElement>('.search-empty')!;
let index: Promise<MiniSearch<Section> | undefined> | undefined;
let results: HTMLAnchorElement[] = [];
let selected = 0;

const loadIndex = () =>
	(index ??= Promise.all([
		import('minisearch'),
		fetch('/search.json').then((response) => {
			if (!response.ok) throw new Error(`search index: ${response.status}`);
			return response.text();
		}),
	])
		.then(([{ default: MiniSearch }, json]) => MiniSearch.loadJSON<Section>(json, SEARCH_OPTIONS))
		.catch(() => {
			// Try again the next time search opens.
			index = undefined;
			return undefined;
		}));

function openSearch() {
	if (dialog.open) return;
	loadIndex();
	dialog.showModal();
	input.select();
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Appends text to an element, with every match of the pattern wrapped in <mark>.
function highlight(parent: HTMLElement, text: string, pattern: RegExp) {
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		parent.append(text.slice(last, match.index));
		const mark = document.createElement('mark');
		mark.textContent = match[0];
		parent.append(mark);
		last = match.index + match[0].length;
	}
	parent.append(text.slice(last));
}

// A window of the text around the first matched word it contains.
function snippet(text: string, words: string[]) {
	const lower = text.toLowerCase();
	const at = Math.min(...words.map((word) => lower.indexOf(word)).filter((i) => i >= 0), Infinity);
	if (at === Infinity || at < SNIPPET_CHARS / 3) {
		return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text;
	}
	const start = text.lastIndexOf(' ', at - SNIPPET_CHARS / 3) + 1;
	const end = start + SNIPPET_CHARS;
	return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function select(next: number) {
	results[selected]?.removeAttribute('aria-selected');
	selected = (next + results.length) % results.length;
	results[selected]?.setAttribute('aria-selected', 'true');
	results[selected]?.scrollIntoView({ block: 'nearest' });
}

async function search() {
	const query = input.value.trim();
	const engine = await loadIndex();
	// A newer keystroke may have run while the index loaded.
	if (query !== input.value.trim()) return;

	list.replaceChildren();
	results = [];
	selected = 0;
	empty.hidden = true;
	if (!query) return;

	const hits = engine?.search(query, QUERY_OPTIONS).slice(0, MAX_RESULTS) ?? [];
	empty.hidden = hits.length > 0;
	for (const hit of hits) {
		const entry = hit as unknown as Section;
		// The words of the index that matched, so a typo highlights the word it matched. Longest first, so a
		// short word doesn't cut a longer one.
		const words = [...hit.terms].sort((a, b) => b.length - a.length);
		const pattern = new RegExp(words.map(escapeRegExp).join('|') || '$^', 'gi');

		const item = document.createElement('li');
		const link = document.createElement('a');
		link.href = entry.url;
		link.setAttribute('role', 'option');

		const title = document.createElement('span');
		title.className = 'search-title';
		highlight(title, entry.heading ? `${entry.page} › ${entry.heading}` : entry.page, pattern);
		const text = document.createElement('span');
		text.className = 'search-text';
		highlight(text, snippet(entry.text, words), pattern);

		link.append(title, text);
		link.addEventListener('mousemove', () => select(results.indexOf(link)));
		// A link to a section of this page doesn't reload, so close search by hand.
		link.addEventListener('click', () => dialog.close());
		item.append(link);
		list.append(item);
		results.push(link);
	}
	select(0);
}

input.addEventListener('input', search);
input.addEventListener('keydown', (event) => {
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		if (results.length) select(selected + (event.key === 'ArrowDown' ? 1 : -1));
	} else if (event.key === 'Enter') {
		event.preventDefault();
		results[selected]?.click();
	} else if (event.key === 'Escape') {
		// A search field clears itself on the first esc. Close search instead, as the esc button says.
		event.preventDefault();
		dialog.close();
	}
});

// A click on the backdrop closes search.
dialog.addEventListener('click', (event) => {
	if (event.target === dialog) dialog.close();
});

document.querySelector('[data-search-open]')!.addEventListener('click', openSearch);
addEventListener('keydown', (event) => {
	const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable]');
	const slash = event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey;
	const commandK = event.key === 'k' && (event.metaKey || event.ctrlKey);
	if (slash || commandK) {
		event.preventDefault();
		openSearch();
	}
});
