/* eslint-disable no-debugger */
import * as bin from '@isopodlabs/binary';
import {Font, tableTypes, loadLocs, loadMetrics, ID, name} from './font';
import {WOFF, WOFF2} from './woff';

export {Font, Glyph, GlyphImage, glyphRef, Metrics, ID} from './font';
export {curveVertex, parseCurve, transformCurve, quadraticCurve, CurveSink, CurveSource} from './curves';

export interface FontGroup {
	fonts: Font[];
	getSub(sub: string): Font | undefined;
}

export interface AsyncFont {
	family(): string | undefined;
	subfamily(): string;
	get(): Promise<Font>;
}

export interface AsyncFontGroup {
	fonts: Promise<AsyncFont>[];
	getSub(sub: string): Promise<AsyncFont | undefined>;
}

const TAG		= bin.String(4);
const u16 		= bin.UINT16_BE;
const u32 		= bin.UINT32_BE;

//-----------------------------------------------------------------------------
//	TTF
//-----------------------------------------------------------------------------

class SFNTHeader extends bin.ReadClass({
	version:		u32,	// 0x00010000 for version 1.0 (or 'true' or 'typ1'); 'OTTO' for opentype
	num_tables:		u16,	// Number of tables.
	search_range:	u16,	// (Maximum power of 2 <= numTables) x 16.
	entry_selector:	u16,	// Log2(maximum power of 2 <= numTables).
	range_shift:	u16,	// NumTables x 16-searchRange.
	tables:	bin.Array(s => s.obj.num_tables, {
		tag:			TAG,	// 4 -byte identifier.
		checksum:		u32,	// CheckSum for this table.
		offset:			u32,	// Offset from beginning of TrueType font file.
		length:			u32,	// Length of this table.
	})
}) {
	getTable(tag: string, file: bin.stream):		Uint8Array | undefined;
	getTable(tag: string, file: bin.async.stream):	bin.MaybePromise<Uint8Array>| undefined;
	getTable(tag: string, file: bin.stream|bin.async.stream) {
		const table = this.tables.find(i => i.tag === tag);
		if (table)
			return file.view_at(Uint8Array, table.offset, table.length);
	}
};

function loadTTF_OTF(file: bin.stream) {
	const font = new Font;

	const sfnt	= file.read(SFNTHeader);
	if (!sfnt || typeof sfnt.getTable !== 'function')
		debugger;

	for (const i of tableTypes) {
		const table = sfnt.getTable(i, file);
		if (table)
			font.loadTable(i, table);
	}

	const loca	= sfnt.getTable('loca', file);
	const glyf	= sfnt.getTable('glyf', file);
	if (loca && glyf)
		font.glyphdata = loadLocs(loca, glyf, font.head!.indexToLocFormat);

	const hmtx = sfnt.getTable('hmtx', file);
	if (hmtx && font.hhea)
		font.hmtx = loadMetrics(hmtx, font.numGlyphs(), font.hhea.numOfLongMetrics);

	return font;
}

async function asyncLoadTTF_OTF(file: bin.async.stream) {
	const sfnt	= await file.read(SFNTHeader);
	if (!sfnt || typeof sfnt.getTable !== 'function')
		debugger;
	const n0	= sfnt.getTable('name', file);
	const n		= n0 ? new name(new bin.stream(await n0)) : undefined;
	return {
		family(): string | undefined { return n?.get(ID.PREF_FAMILY) ?? n?.get(ID.FAMILY); },
		subfamily(): string { return n?.get(ID.PREF_SUBFAMILY) ?? n?.get(ID.SUBFAMILY) ?? 'Regular'; },
		get: async () => {
			const font = new Font;
			for (const i of tableTypes) {
				const table = sfnt.getTable(i, file);
				if (table)
					font.loadTable(i, await table);
			}
			const loca	= sfnt.getTable('loca', file);
			const glyf	= sfnt.getTable('glyf', file);
			if (loca && glyf)
				font.glyphdata = loadLocs(await loca, await glyf, font.head!.indexToLocFormat);

			const hmtx = sfnt.getTable('hmtx', file);
			if (hmtx && font.hhea)
				font.hmtx = loadMetrics(await hmtx, font.numGlyphs(), font.hhea.numOfLongMetrics);

			return font;
		}
	};
}

//-----------------------------------------------------------------------------
//	TTC
//-----------------------------------------------------------------------------

const TTCHeader = {
	tag:			TAG,	// TrueType Collection ID string: 'ttcf'
	version:		u32,	// Version of the TTC Header (1.0), 0x00010000 or (2.0), 0x00020000
	num_fonts:		u32,
};

function loadTTC(file: bin.stream): FontGroup | undefined {
	const head	= file.read(TTCHeader);
	if (head.tag == 'ttcf') {
		const offsets	= bin.readn(file, u32, head.num_fonts);
		const fonts		= offsets.map(offset => { file.seek(offset); return loadTTF_OTF(file); });
		return {
			fonts,
			getSub: (s:string) => fonts.find(i => i.subfamily() === s)
		};
	}
}

async function asyncLoadTTC(file: bin.async.stream): Promise<AsyncFontGroup | undefined> {
	const head	= await file.read(TTCHeader);
	if (head.tag == 'ttcf') {
		const offsets	= await bin.interop.readn(file, u32, head.num_fonts);
		const fonts		= offsets.map(offset => { file.seek(offset); return asyncLoadTTF_OTF(file); });
		return {
			fonts,
			getSub: async (s: string) => fonts.find(async i => (await i).subfamily() === s)
		};
	}
}

//-----------------------------------------------------------------------------
//	load
//-----------------------------------------------------------------------------


export async function asyncLoad(file: bin.async.stream) : Promise< AsyncFont | AsyncFontGroup | undefined> {
	const tag		= await TAG.get(file);
	switch (tag) {
		default:
			if (bin.text.stringCode(tag) != 0x00000100)
				break;
			//fall through
		case 'true':
		case 'typ1':
		case 'OTTO':
			file.seek(0);
			return asyncLoadTTF_OTF(file);

		case 'ttcf':
			file.seek(0);
			return asyncLoadTTC(file);

		//case 'wOFF':
		//case 'wOF2':
	}
}

export function load(data: Uint8Array): Font | FontGroup | Promise<Font> | undefined {
	if (data.length < 256)
		return;

	const file		= new bin.stream(data);
	const tag		= TAG.get(file);
	switch (tag) {
		default:
			if (bin.text.stringCode(tag) != 0x00000100)
				break;
			//fall through
		case 'true':
		case 'typ1':
		case 'OTTO':
			file.seek(0);
			return loadTTF_OTF(file);

		case 'ttcf':
			file.seek(0);
			return loadTTC(file);

		case 'wOFF': return WOFF.load(file);
		case 'wOF2': return WOFF2.load(file);
	}
}


