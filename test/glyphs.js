// Glyphs as binary_fonts reads and writes them, against the same fonts read by fontTools (python, which has to be given:
// FONTTOOLS_PYTHON=/path/to/python with fontTools and brotli; without it those parts are skipped).
//  - a WOFF2 with the glyf transform, which fontTools writes, reads as the TTF it was made from, glyph for glyph
//  - every glyph put through setGlyph and the font written again reads as it did, as TTF, WOFF and WOFF2
//  - fontTools reads what is written, and sees the same outlines and composites as it does in the original
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { load, WOFF, WOFF2, TTF_OTF } = require('../dist/index.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); if (++bad > 40) { console.log('too many failures'); process.exit(1); } } };
const python = process.env.FONTTOOLS_PYTHON;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphs-'));
const r = x => JSON.stringify(x, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v);

const loadFile = async f => { const x = await load(new Uint8Array(fs.readFileSync(f))); return x.fonts ? x.fonts[0] : x; };
const same = (a, b, what) => {
	let differ = 0;
	for (let i = 0; i < a.numGlyphs(); i++) {
		const x = a.getGlyph(i), y = b.getGlyph(i);
		const outline = g => g?.curve?.length ? g.curve : null;		// no points and no curve are the same
		const ok = r(outline(x)) === r(outline(y)) && r(x?.refs ?? null) === r(y?.refs ?? null) && r([x?.min, x?.max]) === r([y?.min, y?.max]) && !!x?.overlap === !!y?.overlap;
		if (!ok && ++differ <= 3)
			check(false, `${what}: glyph ${i} differs: ${r([x?.min, x?.max, x?.refs])} vs ${r([y?.min, y?.max, y?.refs])}; ${x?.curve?.length} vs ${y?.curve?.length} points`);
	}
	check(a.numGlyphs() === b.numGlyphs(), `${what}: glyph count`);
	const ha = a.hmtx.metrics, hb = b.hmtx.metrics;
	check(ha.length === hb.length && ha.every((m, i) => m.advance === hb[i].advance && m.bearing === hb[i].bearing), `${what}: hmtx`);
	return differ;
};

// fontTools' account of a file
const asSeenByFontTools = file => JSON.parse(execFileSync(python, [path.join(__dirname, 'glyphs.py'), file], {maxBuffer: 1 << 30}));
const sameToFontTools = (a, b, what) => {
	let differ = 0;
	check(r(a.order) === r(b.order), `${what}: glyph order`);
	for (const name of a.order) {
		const x = a.glyphs[name], y = b.glyphs[name];
		// the same points drawn: a contour may be written starting elsewhere, so each contour is compared as a set
		// (a contour of fewer than three points is no outline, and is not kept)
		const contours = g => !g.coords ? [] : g.ends.map((e, i) => [i ? g.ends[i - 1] + 1 : 0, e + 1]).filter(([a, b]) => b - a >= 3).map(([a, b]) => g.coords.slice(a, b).map((c, k) => r([c, g.on[a + k]])).sort().join('|')).sort();
		if (r(contours(x)) !== r(contours(y)) && ++differ <= 3)
			check(false, `${what}: ${name} is drawn differently by fontTools`);
	}
	return differ;
};

(async () => {
	for (const [name, file] of [['Georgia', '/System/Library/Fonts/Supplemental/Georgia.ttf'], ['Arial', '/System/Library/Fonts/Supplemental/Arial.ttf']]) {
		const original = await loadFile(file);
		const composites = [...Array(original.numGlyphs()).keys()].filter(i => original.getGlyph(i)?.refs).length;
		console.log(`${name}: ${original.numGlyphs()} glyphs, ${composites} composites`);

		// every glyph put back as it is
		const edited = await loadFile(file);
		for (let i = 0; i < edited.numGlyphs(); i++)
			edited.setGlyph(i, edited.getGlyph(i));
		const out = edited.save();
		fs.writeFileSync(path.join(tmp, `${name}.ttf`), out);
		same(original, await loadFile(path.join(tmp, `${name}.ttf`)), `${name} written again`);
		const wofft = await WOFF.write(edited);
		fs.writeFileSync(path.join(tmp, `${name}-edited.woff`), wofft);
		same(original, await loadFile(path.join(tmp, `${name}-edited.woff`)), `${name} as WOFF`);

		if (!python) { console.log('   (FONTTOOLS_PYTHON not set: the parts that need fontTools were skipped)'); continue; }
		// a WOFF2 made by fontTools (with the glyf transform) reads as the TTF does
		const w2 = path.join(tmp, `${name}.woff2`);
		execFileSync(python, [path.join(__dirname, 'glyphs.py'), file, '--convert-to', w2]);
		const fromWoff2 = await loadFile(w2);
		check(!fromWoff2.rawTables.has('glyf') && !!fromWoff2.glyphdata, `${name}: the WOFF2 is transformed, and has glyph data made from it`);
		console.log(`   WOFF2 by fontTools: ${same(original, fromWoff2, `${name} WOFF2 from fontTools`)} glyphs differ`);

		// and is editable and writable as TTF, WOFF and WOFF2
		const asTTF = TTF_OTF.write(fromWoff2);
		fs.writeFileSync(path.join(tmp, `${name}-from-woff2.ttf`), asTTF);
		same(fromWoff2, await loadFile(path.join(tmp, `${name}-from-woff2.ttf`)), `${name} WOFF2 saved as TTF`);
		const again2 = await WOFF2.write(fromWoff2);
		fs.writeFileSync(path.join(tmp, `${name}-again.woff2`), again2);
		same(fromWoff2, await loadFile(path.join(tmp, `${name}-again.woff2`)), `${name} WOFF2 saved as WOFF2`);

		// fontTools on what was written
		const truth = asSeenByFontTools(file);
		for (const f of [`${name}.ttf`, `${name}-edited.woff`, `${name}-from-woff2.ttf`, `${name}-again.woff2`])
			console.log(`   fontTools reads ${f}: ${sameToFontTools(truth, asSeenByFontTools(path.join(tmp, f)), f)} glyphs differ`);
	}
	console.log(bad ? `${bad} failed` : 'glyphs ok');
	fs.rmSync(tmp, {recursive: true});
	process.exit(bad ? 1 : 0);
})();
