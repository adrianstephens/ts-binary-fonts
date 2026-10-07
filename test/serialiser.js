// GlyphSerialiser written and read again, for what real fonts do not all have: long runs of one flag, large and small
// steps, the overlap flag, hinting when it is given, cubics, every form of a component's scale, components placed by
// matching points, and what is refused.
const bin = require('@isopodlabs/binary');
const { float2x3, float2 } = require('@isopodlabs/maths/vector');
const { GlyphSerialiser } = require('../dist/font.js');
const { curveVertex } = require('../dist/curves.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const r = x => JSON.stringify(x, (k, v) => typeof v === 'number' ? +v.toFixed(5) : v);
const read = bytes => new GlyphSerialiser(new bin.stream(bytes));
const v = (x, y, f) => curveVertex(x, y, f);
const mat = (xx, xy, yx, yy, zx, zy) => { const m = float2x3.identity(); m.x = float2(xx, xy); m.y = float2(yx, yy); m.z = float2(zx, zy); return m; };

// --- simple glyphs
{
	// a contour whose points step by the same small amount (a run of one flag, longer than a flag's count of 255), then
	// a large step, and off-curve points
	const curve = [v(0, 0, 0)];
	for (let i = 1; i <= 300; i++)
		curve.push(v(i, 0, 1));
	curve.push(v(300, 900, 2), v(-1500, 900, 1), v(-1500, -20000, 2), v(-1, -20000, 1));
	curve.push(v(10, 10, 0), v(60, 10, 1), v(60, 60, 2), v(10, 60, 1));
	const bytes = new GlyphSerialiser({curve, overlap: true}).toBytes();
	check(bytes.length % 4 === 0, 'padded to four bytes');
	const g = read(bytes);
	check(r(g.curve) === r(curve), 'the outline is read back as written');
	check(g.overlap === true, 'the overlap flag');
	check(g.min.x === -1500 && g.max.x === 300 && g.min.y === -20000 && g.max.y === 900, `the box of all the points (${r([g.min, g.max])})`);
	check(g.num_contours === 2, 'two contours');
	check((g.instructions?.length ?? 0) === 0, 'no instructions unless given');

	const hinted = read(new GlyphSerialiser({curve, instructions: new Uint8Array([0xb0, 1, 0x2f, 0x2d])}).toBytes());
	check(r([...hinted.instructions]) === r([0xb0, 1, 0x2f, 0x2d]), 'instructions that are given are written');

	const empty = new GlyphSerialiser({curve: []});
	check(empty.toBytes().length === 0, 'a glyph with nothing to draw has no entry');
}

// --- cubics become quadratics; what cannot be written is refused
{
	const cubic = [v(0, 0, 0), v(0, 300, 3), v(300, 600, 3), v(600, 600, 1), v(600, 0, 1)];
	const g = new GlyphSerialiser({curve: cubic});
	check(g.curve.every(p => p.flags <= 2) && g.curve.length > cubic.length - 1, 'a cubic is made of quadratics');
	const back = read(g.toBytes());
	check(r(back.curve) === r(g.curve), 'and they are written as they were made');
	let threw = false;
	try { new GlyphSerialiser({curve: [v(0, 0, 0), v(40000, 0, 1), v(0, 100, 1)]}); } catch (e) { threw = e instanceof RangeError; }
	check(threw, 'a coordinate that does not fit is refused');
	threw = false;
	try { new GlyphSerialiser({refs: [{glyph: 1, mat: mat(1, 0, 0, 1, 0, 0)}]}); } catch { threw = true; }
	check(threw, 'a composite without its box is refused');
}

// --- composites
{
	const box = {min: float2(-5, -6), max: float2(700, 800)};
	const refs = [
		{glyph: 3, mat: mat(1, 0, 0, 1, 0, 0), useMyMetrics: true, roundToGrid: true},
		{glyph: 4, mat: mat(1, 0, 0, 1, 67, -12)},									// byte offsets
		{glyph: 5, mat: mat(1, 0, 0, 1, 300, -200)},								// word offsets
		{glyph: 6, mat: mat(0.5, 0, 0, 0.5, 10, 10)},								// one scale
		{glyph: 7, mat: mat(0.5, 0, 0, -1, 10, 10), scaledOffset: true},			// two scales, a negative one
		{glyph: 8, mat: mat(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)},				// a rotation: all four
		{glyph: 9, mat: mat(1, 0, 0, 1, 0, 0), match: [3, 7]},						// by points, a byte each
		{glyph: 10, mat: mat(1, 0, 0, 1, 0, 0), match: [300, 2]},					// by points, a word each
	];
	const bytes = new GlyphSerialiser({refs, ...box, overlap: true}).toBytes();
	const g = read(bytes);
	check(g.num_contours === -1 && !g.curve, 'a composite');
	check(r([g.min, g.max]) === r([box.min, box.max]), 'with the box it was given');
	check(g.refs.length === refs.length, `${refs.length} components`);
	check(g.overlap === true, 'overlap, on the first component');
	refs.forEach((want, i) => {
		const got = g.refs[i];
		const near = (a, b) => Math.abs(a - b) < 1 / 8192;
		const same = got.glyph === want.glyph
			&& near(got.mat.x.x, want.mat.x.x) && near(got.mat.x.y, want.mat.x.y) && near(got.mat.y.x, want.mat.y.x) && near(got.mat.y.y, want.mat.y.y)
			&& (want.match ? r(got.match) === r(want.match) : got.mat.z.x === want.mat.z.x && got.mat.z.y === want.mat.z.y)
			&& !!got.useMyMetrics === !!want.useMyMetrics && !!got.roundToGrid === !!want.roundToGrid && !!got.scaledOffset === !!want.scaledOffset;
		check(same, `component ${i} comes back as it was (${r(want)} gave ${r(got)})`);
	});

	const hinted = read(new GlyphSerialiser({refs: refs.slice(0, 2), ...box, instructions: new Uint8Array([7, 8, 9])}).toBytes());
	check(hinted.refs.length === 2 && r([...hinted.instructions]) === r([7, 8, 9]), 'a composite with instructions');
	let threw = false;
	try { new GlyphSerialiser({refs: [{glyph: 1, mat: mat(3, 0, 0, 1, 0, 0)}], ...box}).toBytes(); } catch (e) { threw = e instanceof RangeError; }
	check(threw, 'a scale that does not fit is refused');
}

console.log(bad ? `${bad} failed` : 'serialiser ok');
process.exit(bad ? 1 : 0);
