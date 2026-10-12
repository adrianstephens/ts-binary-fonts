import { float2, lerp } from '@isopodlabs/maths/vector';
import * as fontbin from '../dist';

// simplifyCurve keeps every contour within tol of the original while using fewer vertices
const FONT	= '/System/Library/Fonts/Supplemental/STIXGeneral.otf';
const TOL	= 1;	// font units
const STEPS	= 64;

function flatten(curve: fontbin.curveVertex[]) {
	const pts: float2[][] = [];
	fontbin.parseCurve(fontbin.bezier3Curve(curve, 1e-3)).run({
		Begin(a)			{ pts.push([a]); },
		Line(_a, b)			{ pts[pts.length - 1].push(b); },
		Bezier2(a, b, c)	{ for (let i = 1; i <= STEPS; i++) pts[pts.length - 1].push(lerp(lerp(a, b, i / STEPS), lerp(b, c, i / STEPS), i / STEPS)); },
		Bezier3(a, b, c, d)	{ for (let i = 1; i <= STEPS; i++) {
			const t = i / STEPS;
			pts[pts.length - 1].push(lerp(lerp(lerp(a, b, t), lerp(b, c, t), t), lerp(lerp(b, c, t), lerp(c, d, t), t), t));
		} },
	});
	return pts.flat();
}

function distToPolyline(p: float2, poly: float2[]) {
	let d = Infinity;
	for (let i = 1; i < poly.length; i++) {
		const a = poly[i - 1], ab = poly[i].sub(a), l = ab.lensq();
		const t = l ? Math.min(1, Math.max(0, p.sub(a).dot(ab) / l)) : 0;
		d = Math.min(d, p.sub(a.add(ab.scale(t))).len());
	}
	return d;
}

// the farthest any point of either curve is from the other (the polylines are fine enough to stand for the curves)
function deviation(a: fontbin.curveVertex[], b: fontbin.curveVertex[]) {
	const pa = flatten(a), pb = flatten(b);
	return Math.max(pa.reduce((m, p) => Math.max(m, distToPolyline(p, pb)), 0), pb.reduce((m, p) => Math.max(m, distToPolyline(p, pa)), 0));
}

function checkCircle() {
	const r = 50, n = 64, tol = 0.1;
	const circle = Array.from({length: n}, (_, i) => fontbin.curveVertex(r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n), i ? fontbin.ON_CURVE : fontbin.ON_BEGIN));
	const simple = fontbin.simplifyCurve(circle, tol);
	const dev = deviation(circle, simple);
	console.log(`circle: ${circle.length} -> ${simple.length} vertices, deviation ${dev.toFixed(3)}`);
	if (simple.length > 16 || dev > tol + 0.1)
		throw new Error('circle did not simplify well');

	const square = [[0, 0], [10, 0], [20, 0], [20, 10], [20, 20], [0, 20]].map(([x, y], i) => fontbin.curveVertex(x, y, i ? fontbin.ON_CURVE : fontbin.ON_BEGIN));
	const sq = fontbin.simplifyCurve(square, tol);
	if (sq.length != 4 || sq.some(v => v.flags > fontbin.ON_CURVE))
		throw new Error(`collinear lines did not merge: ${JSON.stringify(sq)}`);
}

async function checkFont(file: string, quadratic: boolean) {
	const loaded = await fontbin.loadFile(file);
	const font = loaded instanceof fontbin.Font ? loaded : (loaded as any)?.fonts?.[0];
	if (!(font instanceof fontbin.Font))
		throw new Error(`${file} did not load as a font`);

	let before = 0, after = 0, worst = 0, count = 0;
	for (let id = 0; id < font.numGlyphs(); id += 23) {
		const curve = font.getGlyphCurves(id);
		if (!curve.length)
			continue;
		const simple = fontbin.simplifyCurve(curve, TOL, quadratic);
		const dev = deviation(curve, simple);
		before += curve.length;
		after += simple.length;
		worst = Math.max(worst, dev);
		++count;
		if (dev > TOL * 1.1)
			throw new Error(`glyph ${id}: deviation ${dev} exceeds ${TOL}`);
		if (quadratic && simple.some(v => v.flags > fontbin.OFF_BEZ2))
			throw new Error(`glyph ${id}: cubic vertices remain`);
	}
	console.log(`${file.split('/').pop()}${quadratic ? ' (quadratic)' : ''}: ${count} glyphs: vertices ${before} -> ${after}, worst deviation ${worst.toFixed(3)}`);
}

(async() => {
	checkCircle();
	await checkFont(FONT, false);
	await checkFont(FONT, true);
	await checkFont(__dirname + '/ALGER.TTF', true);
})();
