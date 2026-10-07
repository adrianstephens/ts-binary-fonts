// Writing fonts: every font given is read, written and read again, and the tables must come back byte for byte (head's
// checkSumAdjustment excepted, which depends on the whole file); the written file's checksums must hold. Then a glyph is
// edited: the edit must be what a reader sees, nothing else may change, and -- if Chrome can be found -- its font
// sanitiser must accept the file.
//   node test/roundtrip.js [font...]        (default: some of the fonts macOS has)
const fs = require('fs');
const path = require('path');
const { load, Font, WOFF, WOFF2, TTF_OTF, makeCurveVertex, parseCurve } = require('../dist/index.js');

let bad = 0;
const check = (ok, msg) => { if (!ok) { console.log(`   FAIL: ${msg}`); bad++; } };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function sum(data) {
	let s = 0;
	for (let i = 0; i < data.length; i += 4)
		s = (s + (((data[i] << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)) >>> 0)) >>> 0;
	return s;
}

// the directory of an SFNT file, and whether its checksums hold
function directory(file) {
	const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const tables = {};
	for (let i = 0; i < v.getUint16(4); i++) {
		const e = 12 + i * 16, tag = String.fromCharCode(...file.subarray(e, e + 4));
		tables[tag] = {checksum: v.getUint32(e + 4), offset: v.getUint32(e + 8), length: v.getUint32(e + 12)};
	}
	return tables;
}

function checkFile(file, name) {
	const dir = directory(file);
	for (const [tag, t] of Object.entries(dir)) {
		const data = file.slice(t.offset, t.offset + ((t.length + 3) & ~3));
		if (tag === 'head')
			data.fill(0, 8, 12);
		check(sum(data) === t.checksum, `${name}: checksum of ${tag}`);
		check(t.offset % 4 === 0, `${name}: ${tag} aligned`);
	}
	check(sum(file) === 0xB1B0AFBA, `${name}: whole-file checksum`);
}

const loadAll = async data => {
	const r = await load(data);
	return r instanceof Font ? [r] : r ? r.fonts : [];
};

async function roundTrip(file) {
	const data = new Uint8Array(fs.readFileSync(file));
	const fonts = await loadAll(data);
	console.log(`${path.basename(file)}: ${fonts.length} face${fonts.length === 1 ? '' : 's'}`);
	for (const [n, font] of fonts.entries()) {
		const name = `${path.basename(file)}#${n}`;
		const out = font.save();
		checkFile(out, name);
		const again = (await loadAll(out))[0];
		check(!!again, `${name}: reads again`);
		if (!again)
			continue;
		check(again.numGlyphs() === font.numGlyphs(), `${name}: glyph count`);
		const dir = directory(out);
		for (const [tag, raw] of font.rawTables) {
			if (tag === 'glyf' || tag === 'loca')
				continue;		// rebuilt with padding
			const t = dir[tag];
			if (!t) { check(false, `${name}: ${tag} missing`); continue; }
			const got = out.slice(t.offset, t.offset + t.length), want = new Uint8Array(raw);
			if (tag === 'head') {
				got.fill(0, 8, 12);
				want.fill(0, 8, 12);
			}
			check(same(got, want), `${name}: ${tag} unchanged`);
		}
	}
}

// moves a point of a glyph, and says what a reader makes of the written font
async function edit(file, ch) {
	const data = new Uint8Array(fs.readFileSync(file));
	const font = (await loadAll(data))[0];
	if (!font.glyphdata)
		return;
	const id = font.getGlyphMapping()?.[ch.codePointAt(0)];
	if (!id || !font.getGlyph(id)?.curve?.length) {
		console.log(`   (${path.basename(file)} has no outline for ${ch}: not edited)`);
		return;
	}
	const before = font.getGlyph(id).curve.map(v => ({x: v.x, y: v.y, flags: v.flags}));
	const others = [1, 2, 5, 20, 40, 41].filter(i => i !== id && i < font.numGlyphs()).map(i => [i, JSON.stringify(font.getGlyph(i).curve ?? null)]);
	const rawBefore = new Map(font.rawTables);

	const glyph = font.getGlyph(id);
	glyph.curve[3].x += 37;
	glyph.curve[3].y -= 12;
	glyph.curve.push(makeCurveVertex({x: 5000, y: 100}, 0), makeCurveVertex({x: 5100, y: 100}, 1), makeCurveVertex({x: 5100, y: 200}, 2));		// a new contour, with a control point
	font.setGlyph(id, glyph);
	const out = font.save();
	checkFile(out, `edited ${path.basename(file)}`);

	const again = (await loadAll(out))[0];
	const after = again.getGlyph(id).curve;
	check(after.length === before.length + 3, `glyph ${id}: ${before.length} points became ${after.length}`);
	check(after[3].x === before[3].x + 37 && after[3].y === before[3].y - 12, 'the point moved');
	check(after.every((v, i) => i === 3 || i >= before.length || (v.x === before[i].x && v.y === before[i].y && v.flags === before[i].flags)), 'the other points are as they were');
	check(after.slice(-3).map(v => v.flags).join() === '0,1,2', `the new contour: ${after.slice(-3).map(v => v.flags)}`);
	for (const [i, json] of others)
		check(JSON.stringify(again.getGlyph(i).curve ?? null) === json, `glyph ${i} unchanged`);

	const dir = directory(out);
	const changed = [...rawBefore].filter(([tag, raw]) => !same(out.slice(dir[tag].offset, dir[tag].offset + dir[tag].length), raw)).map(([tag]) => tag).sort();
	console.log(`   editing glyph ${id} of ${path.basename(file)} changed: ${changed.join(' ')}`);
	check(changed.every(t => ['glyf', 'loca', 'head', 'hmtx', 'hhea', 'maxp'].includes(t)), 'only the glyph tables changed');
	check(again.head.max.x >= 5100, 'head covers the new extent');
	check(again.maxp.maxContours >= (after.filter(v => v.flags === 0).length), 'maxp covers the contours');
	return out;
}

// Chrome's font sanitiser, which is a validator that is not this code
async function sanitise(bytes, name) {
	let puppeteer;
	try {
		puppeteer = require(require.resolve('puppeteer-core', {paths: [process.cwd(), '/Volumes/DevSSD/dev/vscode-extensions/bitmaps']}));
	} catch {
		console.log('   (puppeteer-core not found: the sanitiser was not asked)');
		return;
	}
	const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
	if (!fs.existsSync(chrome))
		return;
	const browser = await puppeteer.launch({executablePath: chrome, headless: true});
	try {
		const page = await browser.newPage();
		const result = await page.evaluate(async b64 => {
			try {
				const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
				await new FontFace('edited', bytes).load();
				return 'ok';
			} catch (e) {
				return String(e);
			}
		}, Buffer.from(bytes).toString('base64'));
		check(result === 'ok', `${name}: Chrome rejected the font: ${result}`);
	} finally {
		await browser.close();
	}
}

// a font with CFF outlines made TrueType: the same glyphs, within the tolerance, in a file Chrome accepts
// the extent of the curve itself (not of its control points), by sampling its segments
function extentOf(curve) {
	const xs = [], ys = [];
	const pt = (x, y) => { xs.push(x); ys.push(y); };
	const bez = (ps, t) => { let q = ps; while (q.length > 1) q = q.slice(1).map((p, i) => ({x: q[i].x + (p.x - q[i].x) * t, y: q[i].y + (p.y - q[i].y) * t})); return q[0]; };
	const seg = (...ps) => { for (let k = 0; k <= 24; k++) { const p = bez(ps, k / 24); pt(p.x, p.y); } };
	parseCurve(curve).run({Begin: a => pt(a.x, a.y), End() {}, Line: (a, b) => seg(a, b), Bezier2: (a, b, c) => seg(a, b, c), Bezier3: (a, b, c, d) => seg(a, b, c, d), Arc: () => {}, Arc3: () => {}});
	return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

async function convert(file) {
	const font = (await loadAll(new Uint8Array(fs.readFileSync(file))))[0];
	const ids = [...Array(font.numGlyphs()).keys()].filter(i => font.getGlyph(i)?.curve?.length);
	const extent = id => extentOf(font.getGlyph(id).curve);
	const was = ids.map(extent);
	check(font.convertToTrueType(), 'converted');
	const out = font.save();
	checkFile(out, `converted ${path.basename(file)}`);
	const again = (await loadAll(out))[0];
	check(!again.rawTables.has('CFF ') && !!again.glyphdata && again.maxp.version === 0x10000, 'it is TrueType now');
	ids.forEach((id, k) => {
		const now = extentOf(again.getGlyph(id).curve);
		check(now.every((v, i) => Math.abs(v - was[k][i]) <= 2), `glyph ${id} extent ${was[k]} became ${now}`);
	});
	console.log(`   converted ${path.basename(file)}: ${ids.length} glyphs`);
	await sanitise(out, 'converted ' + path.basename(file));
}

// a font written as WOFF: Chrome accepts it, it is smaller, and reading it gives back the same tables and outlines
async function woff(file) {
	const font = (await loadAll(new Uint8Array(fs.readFileSync(file))))[0];
	const out = await WOFF.write(font);
	const name = `WOFF of ${path.basename(file)}`;
	check(String.fromCharCode(...out.subarray(0, 4)) === 'wOFF', `${name}: signature`);
	check(new DataView(out.buffer).getUint32(8) === out.length, `${name}: length field`);
	// what the WOFF says of the SFNT it stands for is what that SFNT is: its size, and the checksum of each table
	const sfnt = TTF_OTF.write(font), sv = new DataView(sfnt.buffer, sfnt.byteOffset), wv = new DataView(out.buffer);
	check(wv.getUint32(16) === sfnt.length, `${name}: totalSfntSize ${wv.getUint32(16)} is the SFNT's ${sfnt.length}`);
	const sums = new Map();
	for (let i = 0; i < sv.getUint16(4); i++)
		sums.set(String.fromCharCode(...sfnt.subarray(12 + i * 16, 16 + i * 16)), sv.getUint32(16 + i * 16));
	for (let i = 0; i < wv.getUint16(12); i++) {
		const tag = String.fromCharCode(...out.subarray(44 + i * 20, 48 + i * 20));
		check(wv.getUint32(44 + i * 20 + 16) === sums.get(tag), `${name}: checksum of ${tag}`);
	}
	const again = (await loadAll(out))[0];
	check(!!again, `${name}: reads again`);
	if (again) {
		for (const [tag, raw] of font.rawTables) {
			if (tag === 'head')
				continue;		// the adjustment of the sfnt it stands for
			const got = again.rawTables.get(tag);
			check(!!got && same(new Uint8Array(got), new Uint8Array(raw)) || tag === 'glyf' || tag === 'loca', `${name}: ${tag} survives`);
		}
		const m = font.getGlyphMapping()?.['E'.codePointAt(0)];
		if (m && font.getGlyph(m)?.curve)
			check(JSON.stringify(again.getGlyph(m).curve) === JSON.stringify(font.getGlyph(m).curve), `${name}: outline of E`);
	}
	console.log(`   ${path.basename(file)} as WOFF: ${fs.statSync(file).size} -> ${out.length} bytes`);
	await sanitise(out, name);
	return out;
}

// the same as WOFF2
async function woff2(file) {
	const font = (await loadAll(new Uint8Array(fs.readFileSync(file))))[0];
	const t0 = Date.now();
	const out = await WOFF2.write(font);
	const name = `WOFF2 of ${path.basename(file)}`;
	check(String.fromCharCode(...out.subarray(0, 4)) === 'wOF2', `${name}: signature`);
	check(new DataView(out.buffer).getUint32(8) === out.length, `${name}: length field`);
	check(new DataView(out.buffer).getUint32(16) === TTF_OTF.write(font).length, `${name}: totalSfntSize is the SFNT's size`);
	const again = (await loadAll(out))[0];
	check(!!again, `${name}: reads again`);
	if (again) {
		for (const [tag, raw] of font.rawTables) {
			if (tag === 'head')
				continue;
			const got = again.rawTables.get(tag);
			check(!!got && same(new Uint8Array(got), new Uint8Array(raw)) || tag === 'glyf' || tag === 'loca', `${name}: ${tag} survives`);
		}
		const m = font.getGlyphMapping()?.['E'.codePointAt(0)];
		if (m && font.getGlyph(m)?.curve)
			check(JSON.stringify(again.getGlyph(m).curve) === JSON.stringify(font.getGlyph(m).curve), `${name}: outline of E`);
	}
	console.log(`   ${path.basename(file)} as WOFF2: ${fs.statSync(file).size} -> ${out.length} bytes in ${Date.now() - t0} ms`);
	await sanitise(out, name);
}

// a font with no glyph data to write from is refused, not written without its glyphs
async function refuses(file) {
	const font = (await loadAll(new Uint8Array(fs.readFileSync(file))))[0];
	font.glyphdata = undefined;
	font.rawTables.delete('glyf');
	font.rawTables.delete('loca');
	let threw = false;
	try { font.save(); } catch { threw = true; }
	check(threw, 'a font without glyph data cannot be saved');
}

(async () => {
	const files = process.argv.slice(2).length ? process.argv.slice(2) : [
		'/System/Library/Fonts/Supplemental/Georgia.ttf',
		'/System/Library/Fonts/Supplemental/Arial.ttf',
		'/System/Library/Fonts/Helvetica.ttc',
		'/System/Library/Fonts/Apple Color Emoji.ttc',
		'/Users/adrianstephens/Library/Fonts/HouseOfTheDragonColor-rge8L.otf',
		path.join(__dirname, 'ALGER.TTF'),
	].filter(f => fs.existsSync(f));
	for (const f of files)
		await roundTrip(f);
	for (const f of files.filter(f => /\.(ttf|ttc)$/i.test(f))) {
		const out = await edit(f, 'E');
		if (out && /georgia/i.test(f))
			await sanitise(out, 'edited Georgia');
	}
	for (const f of files.filter(f => /\.otf$/i.test(f)))
		await convert(f);
	for (const f of files.filter(f => /\.(ttf|otf)$/i.test(f)))
		await woff(f);
	for (const f of files.filter(f => /\.(ttf|otf)$/i.test(f)))
		await woff2(f);
	await refuses(files[0]);
	console.log(bad ? `${bad} failed` : 'font writing ok');
	process.exit(bad ? 1 : 0);
})();
