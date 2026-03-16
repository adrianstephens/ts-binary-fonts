import * as binary from '@isopodlabs/binary';
import {Font, tableTypes, loadLocs, loadMetrics, name} from './font';
import {WOFF, WOFF2} from "./woff";

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
		return this.fonts.find(i => (i.name as name).names[2] === sub);
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
			//return file.buffer_at(table.offset, table.length);
			return binary.read(file, binary.Offset(table.offset, binary.Buffer(table.length)));
	}

	for (const i of tableTypes) {
		const table = getTable(i);
		if (table)
			font.loadTable(i, table);
	}

	//glyph data
	const loca	= getTable("loca");
	const glyf	= getTable('glyf');
	if (loca && glyf)
		font.glyphdata = loadLocs(loca, glyf, font.head!.indexToLocFormat);

	//hmtx
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
/*
const TTCHeader2 = {
	tag:			TAG,	// Tag indicating that a DSIG table exists, 0x44534947 ('DSIG') (null if no signature)
	length:			u32,	// The length (in bytes) of the DSIG table (null if no signature)
	offset:			u32,	// The offset (in bytes) of the DSIG table from the beginning of the TTC file (null if no signature)
};
*/
class TTC extends FontGroup {
	constructor(file: binary.stream) {
		super();
		const head	= binary.read(file, TTCHeader);
		if (head.tag == "ttcf") {
			const	offsets = binary.readn(file, u32, head.num_fonts);
			this.fonts = offsets.map(offset => { file.seek(offset); return loadTTF_OTF(file); });
		}
	}

	getSub(sub: string) {
		return this.fonts.find(ttf => ttf.name?.names[2] === sub);
	}
}

//-----------------------------------------------------------------------------
//	EOT	- embedded opentype
//-----------------------------------------------------------------------------
/*
const EOTname = binary.String(u16);

const EOTHeader = {
	//enum {MAGIC = 0x504c};

	eot_size:	u32,
	font_size:	u32,
	version:	u32,
	flags:		u32,
	panose:		PANOSE,
	charset:	u8,
	italic:		u8,
	weight:		u32,
	type:		u16,
	magic:		u16,
	unicode_range:			binary.Array(4, u32),
	codepage_range:			binary.Array(2, u32),
	checksum_adjustment:	u32,
	reserved:				binary.Array(4, u32),

	//all padding values must be set to 0x0000
	padding1:		u16,
	family_name:	EOTname,		//Family string found in the name table of the font (name ID = 1)
	padding2:		u16,
	style_name:		EOTname,		//Subfamily string found in the name table of the font (name ID = 2)
	padding3:		u16,
	version_name:	EOTname,		//Version string found in the name table of the font (name ID = 5)
	padding4:		u16,
	full_name:		EOTname,		//Full name string found in the name table of the font (name ID = 4)

	v2_1:	binary.Optional(s => s.obj.version >= 0x00020001, {
		padding5:		u16,
		root_string:	EOTname,

		v2_2:	binary.Optional(s => s.obj.version >= 0x00020002, {
			root_string_checksum:	u32,
			EUDC_codepage:	u32,
			padding6:		u16,
			signature:		EOTname,
			EUDCFlags:		u32,			//processing flags for the EUDC font. Typical values might be TTEMBED_XORENCRYPTDATA and TTEMBED_TTCOMPRESSED.
			EUDCFontData:	EOTname,
		}),
	}),

	data:	binary.Buffer(s => s.obj.font_size),//font_size];	//compressed or XOR encrypted as indicated by the processing flags.
};
*/
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

import * as fs from 'fs/promises';

export async function loadFile(filename: string): Promise<Font | FontGroup | undefined> {
	return fs.readFile(filename).then(data => load(data));
}
