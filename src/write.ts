// Writing fonts: the inverse of what font.ts reads, for TrueType outlines.
//
// A font is written from the bytes it was read from. Every table is copied as it was unless `font.modified` says it is
// to be made again from what the font holds now: glyf and loca from `glyphdata`, hmtx from `hmtx`. The few tables
// that summarise the glyphs (head, hhea, maxp) are read through their definitions, changed, and written back with
// whatever follows them, so every field this does not understand is kept; and they are only ever made to cover more,
// never less -- which is always valid, if not always tight.
import * as bin from '@isopodlabs/binary';
import type { Font } from './font';
import { SFNTHeader, head as Head, MetricsHead, saveMetrics, maxp as Maxp } from './font';

const u16 = bin.UINT16_BE;
const u32 = bin.UINT32_BE;


const concat = (a: Uint8Array, b: Uint8Array) => {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
};

//-----------------------------------------------------------------------------
//	tables
//-----------------------------------------------------------------------------

export function checksum(data: Uint8Array) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength & ~3);
	let sum = 0;
	for (let i = 0; i < view.byteLength; i += 4)
		sum = (sum + view.getUint32(i)) >>> 0;
	// the last bytes are summed as if padded with zeros
	for (let i = view.byteLength, shift = 24; i < data.length; i++, shift -= 8)
		sum = (sum + (data[i] << shift)) >>> 0;
	return sum;
}

// Where everything goes in an SFNT file, which is what the other formats take their numbers from too: the tables as they
// are written (head with the adjustment its checksum needs), a directory of them in order of tag (as binary search needs
// it to be) with where each is and its checksum, and how long the file is. No bytes are put together: the whole file's
// checksum is only the directory's and each table's added up, so it can be worked out without the file.
export interface Layout {
	tables:	Map<string, Uint8Array>;
	header:	SFNTHeader;				// its tables are the directory
	size:	number;					// of the SFNT file, each table padded to four bytes
}

export function layout(font: Font): Layout {
	const tables = new Map(font.rawTables);
	// a font whose glyphs were decoded from a form with no glyf of its own (a WOFF2 with the glyf transform) has nothing
	// to write them from, and a file without them would be silently wrong

	const glyphdata = font.glyphdata;

	if (!glyphdata) {
		if (!tables.has('glyf') && !tables.has('CFF ') && !tables.has('CFF2') && (font.cached.length || font.numGlyphs()))
			throw new Error('this font\'s glyphs were read from a transformed WOFF2 and cannot be written yet');

	} else {
		let longLoca	= font.head?.indexToLocFormat === 1;
		const rebuilt	= font.modified.has('glyf') || !tables.has('glyf');

		if (rebuilt) {
			const offsets: number[] = [];
			let total = 0;
			for (const g of glyphdata) {
				offsets.push(total);
				total += (g.length + 3) & ~3;
			}
			offsets.push(total);

			const glyf = new Uint8Array(total);
			glyphdata.forEach((g, i) => glyf.set(g, offsets[i]));
			tables.set('glyf', glyf);

			longLoca	= total >= 0x20000;
			const s		= new bin.growingStream();
			bin.writen(s, longLoca ? u32 : u16, longLoca ? offsets : offsets.map(o => o / 2));

			tables.set('loca', s.terminate());
		}

		if (font.hmtx && (font.modified.has('hmtx') || !tables.has('hmtx')))
			tables.set('hmtx', saveMetrics(font.hmtx));

		if (font.modified.size || rebuilt) {
			// head, hhea and maxp's fields that summarise the glyphs, made to cover the glyphs that have been edited
			// a table as its definition has it, and a way to put it back with what followed it in the file
			const open = <T extends {write(s: bin.stream): void}>(tag: string, type: new (s: bin.stream) => T) => {
				const raw = tables.get(tag);
				if (!raw)
					return undefined;
				const table = new type(new bin.stream(raw));
				return {table, store: () => {
					const bytes = bin.toBytes(table);
					tables.set(tag, concat(bytes, raw.subarray(bytes.length)));
				}};
			};

			const head = open('head', Head);
			if (head) {
				const h = head.table;
				h.indexToLocFormat = longLoca ? 1 : 0;
				for (const {min, max} of font.edits.values()) {
					h.min.x = Math.min(h.min.x, min.x);
					h.min.y = Math.min(h.min.y, min.y);
					h.max.x = Math.max(h.max.x, max.x);
					h.max.y = Math.max(h.max.y, max.y);
				}
				h.modified = new Date();
				head.store();
			}

			const hhea = open('hhea', MetricsHead);
			if (hhea) {
				const h = hhea.table;
				const advance = (id: number) => font.hmtx?.metrics[Math.min(id, font.hmtx.metrics.length - 1)]?.advance ?? 0;
				for (const [id, {min, max}] of font.edits) {
					h.advanceMax		= Math.max(h.advanceMax, advance(id));
					h.minASideBearing	= Math.min(h.minASideBearing, min.x);					// the left side bearing is xMin
					h.minBSideBearing	= Math.min(h.minBSideBearing, advance(id) - max.x);
					h.maxExtent			= Math.max(h.maxExtent, max.x);							// lsb + (xMax - xMin)
				}
				hhea.store();
			}

			const maxp = open('maxp', Maxp);
			if (maxp && maxp.table.version >= 0x00010000) {
				const m = maxp.table;
				for (const {points, contours, components} of font.edits.values()) {
					m.maxPoints		= Math.max(m.maxPoints, points);
					m.maxContours	= Math.max(m.maxContours, contours);
					if (components)
						m.maxComponentElements = Math.max(m.maxComponentElements, components);
				}
				maxp.store();
			}
		}
	}

	const tags				= [...tables.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	const num_tables		= tags.length;
	const entry_selector	= Math.floor(Math.log2(num_tables));
	const search_range		= 16 << entry_selector;

	// head's adjustment is not part of the checksum it adjusts, and is worked out from the rest of the file. It is the head
	// outputTables made (with the loca format and bounds the glyphs need), not the one the font was read with.
	const headBytes = tables.get('head');
	const withAdjustment = (adjustment: number) => {
		const head = new Head(new bin.stream(headBytes!));
		head.checksum_adj = adjustment;
		const bytes = bin.toBytes(head);
		return concat(bytes, headBytes!.subarray(bytes.length));
	};
	if (headBytes)
		tables.set('head', withAdjustment(0));

	let size = 12 + 16 * num_tables;
	const entries = tags.map(tag => {
		const data		= tables.get(tag)!;
		const length	= data.length;
		const offset	= size;
		size += (length + 3) & ~3;
		return {tag, checksum: checksum(data), offset, length};
	});

	const header = new SFNTHeader({version: font.sfntVersion, num_tables, search_range, entry_selector, range_shift: num_tables * 16 - search_range, tables: entries});
	if (headBytes) {
		const whole = entries.reduce((sum, e) => (sum + e.checksum) >>> 0, checksum(bin.toBytes(header)));
		tables.set('head', withAdjustment((0xB1B0AFBA - whole) >>> 0));
	}
	return {tables, header, size};
}
