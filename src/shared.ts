import * as binary from '@isopodlabs/binary';
import {Font, tableTypes, loadLocs, loadMetrics, ID} from './font';
import {WOFF, WOFF2} from './woff';

export {Font} from './font';

const TAG		= binary.String(4);
const u16 		= binary.UINT16_BE;
const u32 		= binary.UINT32_BE;

//-----------------------------------------------------------------------------
//	Font Group
//-----------------------------------------------------------------------------

export abstract class FontGroup {
	fonts: Font[] = [];
	getSub(sub: string) {
		return this.fonts.find(i => i.name?.get(ID.SUBFAMILY) === sub);
	}
}

//-----------------------------------------------------------------------------
//	TTF
//-----------------------------------------------------------------------------

const SFNTHeader = {
	version:		u32,	// 0x00010000 for version 1.0 (or 'true' or 'typ1'); 'OTTO' for opentype
	num_tables:		u16,	// Number of tables.
	search_range:	u16,	// (Maximum power of 2 <= numTables) x 16.
	entry_selector:	u16,	// Log2(maximum power of 2 <= numTables).
	range_shift:	u16,	// NumTables x 16-searchRange.
	tables:	binary.Array(s => s.obj.num_tables, {
		tag:			TAG,	// 4 -byte identifier.
		checksum:		u32,	// CheckSum for this table.
		offset:			u32,	// Offset from beginning of TrueType font file.
		length:			u32,	// Length of this table.
	}),
};

function loadTTF_OTF(file: binary.stream) {
	const font = new Font;

	const sfnt	= binary.read(file, SFNTHeader);

	function getTable(tag: string) {
		const table = sfnt.tables.find(i => i.tag === tag);
		if (table)
			return binary.read(file, binary.Offset(table.offset, binary.Buffer(table.length)));
	}

	for (const i of tableTypes) {
		const table = getTable(i);
		if (table)
			font.loadTable(i, table);
	}

	const loca	= getTable('loca');
	const glyf	= getTable('glyf');
	if (loca && glyf)
		font.glyphdata = loadLocs(loca, glyf, font.head!.indexToLocFormat);

	const hmtx = getTable('hmtx');
	if (hmtx && font.hhea)
		font.hmtx = loadMetrics(hmtx, font.numGlyphs(), font.hhea.numOfLongMetrics);

	return font;
}

//-----------------------------------------------------------------------------
//	TTC
//-----------------------------------------------------------------------------

const TTCHeader = {
	tag:			TAG,	// TrueType Collection ID string: 'ttcf'
	version:		u32,	// Version of the TTC Header (1.0), 0x00010000 or (2.0), 0x00020000
	num_fonts:		u32,
};

class TTC extends FontGroup {
	constructor(file: binary.stream) {
		super();
		const head	= binary.read(file, TTCHeader);
		if (head.tag == 'ttcf') {
			const offsets = binary.readn(file, u32, head.num_fonts);
			this.fonts = offsets.map(offset => { file.seek(offset); return loadTTF_OTF(file); });
		}
	}

	getSub(sub: string) {
		return this.fonts.find(ttf => ttf.name?.get(ID.SUBFAMILY) === sub);
	}
}

//-----------------------------------------------------------------------------
//	load
//-----------------------------------------------------------------------------

export function load(data: Uint8Array): Font | FontGroup | Promise<Font> | undefined {
	if (data.length < 256)
		return;

	const file		= new binary.stream(data);
	const tag		= TAG.get(file);
	switch (tag) {
		default:
			if (binary.utils.stringCode(tag) != 0x00000100)
				break;
			//fall through
		case 'true':
		case 'typ1':
		case 'OTTO':
			file.seek(0);
			return loadTTF_OTF(file);

		case 'ttcf': return new TTC(file);
		case 'wOFF': return WOFF.load(file);
		case 'wOF2': return WOFF2.load(file);
	}
}