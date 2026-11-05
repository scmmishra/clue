// Draws the clue logo as ASCII. The 404 page renders one frame at build time and animates it in the browser.

// The logo glyph on its 9 by 9 grid, as in public/logo.svg. `#` is a filled cell.
const GLYPH = [
	'##.......',
	'##.......',
	'##...###.',
	'##..#####',
	'##..#####',
	'##..#####',
	'##...###.',
	'##.......',
	'##.......',
];

// Characters per logo cell, and empty characters around the glyph for the glow.
const SCALE = 4;
const PAD = 6;
const GLOW_RADIUS = 3;

// From empty to dense. Lines are as tall as characters are wide, so the dots form a square grid.
const RAMP = ' .·:;+=*#%';

export const SIZE = GLYPH.length * SCALE + PAD * 2;

// How bright each character is at rest, from 0 to 1. Inside the glyph it is bright, and a soft glow fades out around it.
const base: number[] = (() => {
	const inside = (x: number, y: number) => {
		const col = Math.floor((x - PAD) / SCALE);
		const row = Math.floor((y - PAD) / SCALE);
		return GLYPH[row]?.[col] === '#' ? 1 : 0;
	};
	const levels: number[] = [];
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			let sum = 0;
			let count = 0;
			for (let dy = -GLOW_RADIUS; dy <= GLOW_RADIUS; dy++) {
				for (let dx = -GLOW_RADIUS; dx <= GLOW_RADIUS; dx++) {
					sum += inside(x + dx, y + dy);
					count++;
				}
			}
			const glow = sum / count;
			levels.push(inside(x, y) ? 0.7 + 0.3 * glow : 0.4 * glow);
		}
	}
	return levels;
})();

const glyphFor = (level: number) => RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1))))];

// The logo at rest.
export function staticFrame(): string {
	const lines: string[] = [];
	for (let y = 0; y < SIZE; y++) {
		let line = '';
		for (let x = 0; x < SIZE; x++) line += glyphFor(base[y * SIZE + x]);
		lines.push(line);
	}
	return lines.join('\n');
}

const INTRO_MS = 1200;
const WAVE_MS = 3200;
const WAVE_WIDTH = 0.08;
const FLICKER = 0.12;

// When each character settles during the intro, as a fraction of INTRO_MS. Characters near the centre settle first.
const settle = base.map((_, index) => {
	const x = (index % SIZE) / SIZE - 0.5;
	const y = Math.floor(index / SIZE) / SIZE - 0.5;
	return Math.min(1, Math.hypot(x, y) * 1.2 + Math.random() * 0.35);
});

// The logo `ms` milliseconds after the animation starts. Characters scramble into place, then a band of light
// sweeps across the glyph from the top left, and the dots flicker a little.
export function frame(ms: number): string {
	const intro = Math.min(1, ms / INTRO_MS);
	// The band's position along the diagonal, from just before the top left corner to just past the bottom right.
	const band = ((ms % WAVE_MS) / WAVE_MS) * 1.6 - 0.3;
	const lines: string[] = [];
	for (let y = 0; y < SIZE; y++) {
		let line = '';
		for (let x = 0; x < SIZE; x++) {
			const index = y * SIZE + x;
			const level = base[index];
			if (intro < settle[index]) {
				line += level > 0.05 && Math.random() < 0.5 ? RAMP[1 + Math.floor(Math.random() * (RAMP.length - 1))] : ' ';
				continue;
			}
			const distance = (x + y) / (SIZE * 2) - band;
			const wave = Math.exp(-(distance * distance) / WAVE_WIDTH ** 2 / 2);
			const flicker = level > 0.05 ? (Math.random() - 0.5) * FLICKER : 0;
			line += glyphFor(level * (0.65 + 0.5 * wave) + flicker * level);
		}
		lines.push(line);
	}
	return lines.join('\n');
}
