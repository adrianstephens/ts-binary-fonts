import { float2 } from '@isopodlabs/maths/vector';
import * as fontbin from '../dist';

// lower every glyph of a CFF (cubic) font to quadratics, and check nothing cubic is left; and lower some arcs
const FONT		= '/System/Library/Fonts/Supplemental/STIXGeneral.otf';
const OFF_BEZ2	= 2;	// flags above this are cubic or arc vertices
const TOL		= 1;	// font units

// a circle of radius r about the origin, as arcs: a quarter turn each way, on the 2-off-curve and 1-off-curve forms
function checkArcs() {
	const r = 50, tol = 0.05, V = (x: number, y: number, flags: number) => fontbin.makeCurveVertex(float2(x, y), flags);
	const outlines = [
		[V(r, 0, 0), V(r, 2 * r, 8), V(2 * r, r, 8), V(0, r, 1)],
		[V(r, 0, 0), V(r, -2 * r, 8), V(2 * r, -r, 8), V(0, -r, 1)],
		[V(r, 0, 0), V(r, r, 8), V(0, r, 1)],
	];
	outlines.forEach((outline, i) => {
		const lowered = fontbin.quadraticCurve(outline, tol);
		if (lowered.some(v => v.flags > OFF_BEZ2))
			throw new Error(`arc ${i}: arc vertices remain`);
		fontbin.parseCurve(lowered).run({
			Bezier2(a, b, c) {
				for (const t of [0, 0.25, 0.5, 0.75, 1]) {
					const u = 1 - t, x = u * u * a.x + 2 * u * t * b.x + t * t * c.x, y = u * u * a.y + 2 * u * t * b.y + t * t * c.y;
					if (Math.abs(Math.hypot(x, y) - r) > tol)
						throw new Error(`arc ${i}: (${x}, ${y}) is off the circle`);
				}
			}
		});
	});
}

(async() => {
	checkArcs();

	const loaded = await fontbin.loadFile(FONT);
	const font = loaded instanceof fontbin.Font ? loaded : (loaded as any)?.fonts?.[0];
	if (!(font instanceof fontbin.Font))
		throw new Error(`${FONT} did not load as a font`);

	let glyphs = 0, empty = 0, cubics = 0, before = 0, after = 0;
	const failures: string[] = [];

	for (let id = 0; id < font.numGlyphs(); id++) {
		try {
			const curve = font.getGlyphCurves(id);
			if (!curve.length) {
				++empty;
				continue;
			}
			++glyphs;
			const lowered = fontbin.quadraticCurve(curve, TOL);
			if (curve.some(v => v.flags > OFF_BEZ2))
				++cubics;
			before += curve.length;
			after += lowered.length;
			if (lowered.some(v => v.flags > OFF_BEZ2))
				failures.push(`glyph ${id}: cubic vertices remain`);
		} catch (e) {
			failures.push(`glyph ${id}: ${e instanceof Error ? e.message : e}`);
		}
	}

	console.log(`${glyphs} glyphs (${empty} empty), ${cubics} contained cubics; vertices ${before} -> ${after}`);
	if (failures.length) {
		console.error(`${failures.length} failures:\n` + failures.slice(0, 20).join('\n'));
		process.exit(1);
	}
	if (!cubics)
		throw new Error('expected a CFF font with cubic curves');
})();
