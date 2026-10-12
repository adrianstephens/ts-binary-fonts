// The SVG side of the package: path data as editable contours (open ones staying open), basic shapes as path data, and the
// glyphs of an OpenType-SVG table taken out as documents of their own and put back edited, with a definition that other
// glyphs share left as the others have it.
const fs = require('fs');
const path = require('path');
const { load, Font, TTF_OTF, parseSVGpath, makeCurve, bezier3Curve, parseCurve, parseSVGshape, parseSVG } = require('../dist/index.js');
const svgPathCurve = d => bezier3Curve(makeCurve(parseSVGpath(d, true)), 1e-6);

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const flat = contours => contours.map(c => ({closed: c.closed, flags: c.curve.map(v => v.flags).join('')}));
const r = x => JSON.stringify(x);

// --- one curve: closed subpaths implied, open ones ended by ON_END
{
	const flags = c => c.map(v => v.flags).join('');
	const c = svgPathCurve('M0 0L10 0L10 10L0 0Z M20 20 L30 20 Q40 30 50 20 C1 2 3 4 5 6');
	check(flags(c) === '011' + '0121334', `closed then open: ${flags(c)}`);
	check(c.length === 10, 'a closed subpath does not repeat its begin point');
	const sides = [];
	parseCurve(c.slice(0, 3)).run({Line: (a, b) => sides.push([b.x, b.y].join()), End: open => sides.push(open ? 'open' : 'closed')});
	check(sides.join(' ') === '10,0 10,10 0,0 closed', `a closed one is closed by parseCurve: ${sides}`);
	const ends = [];
	parseCurve(c.slice(3)).run({Line: (a, b) => ends.push([b.x, b.y].join()), End: open => ends.push(open ? 'open' : 'closed')});
	check(ends[ends.length - 1] === 'open' && !ends.includes('20,20'), `an open one is not: ${ends}`);
	const arc = svgPathCurve('M0 0 A10 10 0 0 1 20 0');
	check(arc.every(v => v.flags <= 4) && arc.length >= 4 && arc[arc.length - 1].flags === 4, 'an arc becomes cubics');
	check(svgPathCurve('M5 5').length === 0, 'a lone move has nothing to edit');
	check(flags(svgPathCurve('M0 0h10v10z')) === '011', 'relative commands');
}

// --- shapes as curves
{
	const e = (name, attributes) => ({name, attributes});
	const curve = (name, attributes, open) => bezier3Curve(makeCurve(parseSVGshape(e(name, attributes), open) ?? {run() {}}), 1e-6);
	const flags = c => c.map(v => v.flags).join('');
	check(flags(curve('rect', {x: '1', y: '2', width: '3', height: '4'})) === '0111', 'a rect is four corners');
	check(flags(curve('rect', {width: '10', height: '10', rx: '2'})).length > 8, 'a rounded rect has corners');
	check(makeCurve(parseSVGshape(e('rect', {width: '0', height: '5'}))).length === 0, 'an empty rect has nothing');
	check(curve('circle', {cx: '0', cy: '0', r: '5'}).every(v => v.flags <= 3) && curve('circle', {cx: '0', cy: '0', r: '5'}).length >= 8, 'a circle is cubics');
	check(flags(curve('polygon', {points: '0,0 10,0 10,10'}, true)) === '011', 'a polygon is closed');
	check(flags(curve('polyline', {points: '0,0 10,0 10,10'}, true)) === '014', 'a polyline is open for editing');
	check(flags(curve('polyline', {points: '0,0 10,0 10,10'})) === '011', 'and closed for filling');
	check(flags(curve('line', {x1: '0', y1: '0', x2: '5', y2: '5'}, true)) === '04' && makeCurve(parseSVGshape(e('line', {}))).length === 0, 'a line is open, and has no inside');
	check(parseSVGshape(e('text', {})) === undefined, 'text is not a shape');
	const doc = parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><rect width="30" height="40"/><circle cx="50" cy="50" r="10"/><polygon points="0,0 5,0 5,5"/></svg>');
	check(doc.shapes.length === 3, `parseSVG draws what shapeCurve makes: ${doc.shapes.length}`);
}

// --- an SVG table of three documents: one glyph's own (its root is the glyph), and two glyphs that share definitions
function svgTable(docs) {
	const list = 2 + 12 * docs.length;
	const bytes = docs.map(d => Buffer.from(d.text));
	const out = Buffer.alloc(10 + list + bytes.reduce((n, b) => n + b.length, 0));
	out.writeUInt32BE(10, 2);
	out.writeUInt16BE(docs.length, 10);
	let offset = list;
	docs.forEach((d, i) => {
		out.writeUInt16BE(d.start, 12 + 12 * i);
		out.writeUInt16BE(d.end, 14 + 12 * i);
		out.writeUInt32BE(offset, 16 + 12 * i);
		out.writeUInt32BE(bytes[i].length, 20 + 12 * i);
		bytes[i].copy(out, 10 + offset);
		offset += bytes[i].length;
	});
	return new Uint8Array(out);
}

(async () => {
	let font = await load(new Uint8Array(fs.readFileSync(path.join(__dirname, 'ALGER.TTF'))));
	if (!(font instanceof Font))
		font = font.fonts[0];
	const alone = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" id="glyph3"><g fill="none"><path d="M0 0L100 0L100 -100Z" fill="#ff0000"/></g></svg>';
	const shared = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient><path id="part" d="M0 0L50 0L50 -50Z" fill="url(#g1)"/></defs><g id="glyph5"><use href="#part"/><path d="M1 1L2 2L3 1Z" fill="#00f"/></g><g id="glyph6"><use href="#part"/></g></svg>';
	font.loadTable('SVG ', svgTable([{start: 3, end: 3, text: alone}, {start: 5, end: 6, text: shared}]));

	const docs = font.svgDocuments();
	check(docs.length === 2 && docs[0].start === 3 && docs[1].end === 6 && docs[0].text === alone, 'the documents are read');
	check(font.getGlyphSVGDocument(4) === undefined, 'a glyph with no document has none');

	// a glyph whose document is its own
	const g3 = font.getGlyphSVGDocument(3, '0 -800 1000 1000');
	check(g3.includes('viewBox="0 -800 1000 1000"') && g3.includes('<g id="glyph3">') && g3.includes('fill="#ff0000"'), `its own document: ${g3}`);
	font.setGlyphSVGDocument(3, g3.replace('#ff0000', '#00ff00'));
	const after3 = font.svgDocuments()[0].text;
	check(after3.includes('#00ff00') && after3.includes('viewBox="0 0 1000 1000"') && after3.includes('id="glyph3"') && !after3.includes('<g id="glyph3">'), `put back in the document: ${after3}`);

	// glyphs that share: 5 has what it uses, and no more
	const g5 = font.getGlyphSVGDocument(5, '0 -800 1000 1000');
	check(g5.includes('d="M0 0L50 0L50 -50Z"') && g5.includes('<linearGradient id="g1">') && g5.includes('<g id="glyph5">') && !g5.includes('glyph6'), `a shared document's glyph: ${g5}`);

	// a gradient that a shared part uses, changed for one glyph: the part is added as another for that glyph too
	const saved = font.rawTables.get('SVG ');
	font.setGlyphSVGDocument(6, font.getGlyphSVGDocument(6).replace('#000', '#abcdef'));
	const six = font.getGlyphSVGDocument(6), five = font.getGlyphSVGDocument(5);
	check(six.includes('#abcdef') && /<use href="#part-1"/.test(six) && six.includes('url(#g1-1)'), `the part follows its gradient: ${six}`);
	check(!five.includes('#abcdef') && five.includes('<use href="#part"/>') && five.includes('#000'), 'and the other glyph keeps both');
	font.loadTable('SVG ', saved);

	// changing the shared part for 5 leaves 6 as it was
	font.setGlyphSVGDocument(5, g5.replace('M0 0L50 0L50 -50Z', 'M0 0L90 0L90 -90Z'));
	const g5b = font.getGlyphSVGDocument(5), g6 = font.getGlyphSVGDocument(6);
	check(g5b.includes('M0 0L90 0L90 -90Z') && !g5b.includes('M0 0L50 0L50 -50Z'), 'the glyph has its edit');
	check(g6.includes('M0 0L50 0L50 -50Z') && !g6.includes('M0 0L90 0L90 -90Z'), `and the other glyph does not: ${g6}`);
	check(/href="#part-1"/.test(g5b), 'the edited part is a new one, which the glyph uses');

	// a gradient others use, changed for one glyph, is changed for that glyph only
	font.setGlyphSVGDocument(6, g6.replace('#000', '#123456'));
	const g6b = font.getGlyphSVGDocument(6), g5c = font.getGlyphSVGDocument(5);
	check(g6b.includes('#123456') && g6b.includes('url(#g1-1)'), `glyph 6 has a gradient of its own, which its part (now only its) uses: ${g6b}`);
	check(!g5c.includes('#123456') && g5c.includes('#000'), 'glyph 5 does not');

	// a definition no one else uses is changed where it is
	font.setGlyphSVGDocument(5, font.getGlyphSVGDocument(5).replace('#00f', '#0000aa'));
	check(font.svgDocuments()[1].text.includes('#0000aa') && !/id="glyph5"[^]*id="glyph5"/.test(font.svgDocuments()[1].text), 'a change to the glyph alone');

	// written as a font and read again
	const again = await load(TTF_OTF.write(font));
	const font2 = again instanceof Font ? again : again.fonts[0];
	check(r(font2.svgDocuments()) === r(font.svgDocuments()), 'the font written and read again has the same documents');

	console.log(bad ? `${bad} FAILED` : 'svg glyphs ok');
	process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
