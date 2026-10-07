import * as xml from '@isopodlabs/xml';
import * as bin from '@isopodlabs/binary';
import {Font, vec2, Glyph, GlyphSerialiser, loadLocs, loadMetrics, readComposite, contoursToCurve} from './font';
import {float2} from '@isopodlabs/maths/vector';
import {layout} from './write';

const TAG		= bin.String(4);
const u8 		= bin.UINT8;
const u16 		= bin.UINT16_BE;
const s16 		= bin.INT16_BE;
const u32 		= bin.UINT32_BE;

//-----------------------------------------------------------------------------
//	WOFF
//-----------------------------------------------------------------------------

//@internal
export const WOFFHeader = {
	signature:		u32,	//0x774F4646 'wOFF'
	flavor:			u32,	//The "sfnt version" of the input font.
	length:			u32,	//Total size of the WOFF file.
	numTables:		u16,	//Number of entries in directory of font tables.
	reserved:		u16,	//Reserved; set to zero.
	totalSfntSize:	u32,	//Total size needed for the uncompressed font data, including the sfnt header, directory, and font tables (including padding).
	version:		u32,	//Major.Minor version of the WOFF file.
	metaOffset:		u32,	//Offset to metadata block, from beginning of WOFF file.
	metaLength:		u32,	//Length of compressed metadata block.
	metaOrigLength:	u32,	//Uncompressed size of metadata block.
	privOffset:		u32,	//Offset to private data block, from beginning of WOFF file.
	privLength:		u32,	//Length of private data block.

	tables:	bin.Array(s => s.obj.numTables, {
		tag:			TAG,	//4-byte sfnt table identifier.
		offset:			u32,	//Offset to the data, from beginning of WOFF file.
		compLength:		u32,	//Length of the compressed data, excluding padding.
		origLength:		u32,	//Length of the uncompressed table, excluding padding.
		origChecksum:	u32,	//Checksum of the uncompressed table.
	}),
};

export class WOFF extends Font {
	metadata?:	xml.Element;
	priv?:		Uint8Array;

	static async load(file: bin.stream) {
		const me 	= new WOFF;
		const h		= bin.read(file, WOFFHeader);

		const inflate = bin.decompress('deflate');		// zlib, as the format says

		if (h.metaLength) {
			const buffer = inflate(bin.read(file, bin.Offset(h.metaOffset, bin.Buffer(h.metaLength))));
			me.metadata = xml.parse(bin.text.decode(await buffer));
		}
		if (h.privLength) {
			const buffer = inflate(bin.read(file, bin.Offset(h.privOffset, bin.Buffer(h.privLength))));
			me.priv = await buffer;
		}

		function findTable(tag: string) {
			return h.tables.find(i => i.tag === tag);
		}
		function getTable(tag: string) {
			const table = findTable(tag);
			if (table) {
				const buffer = bin.read(file, bin.Offset(table.offset, bin.Buffer(table.compLength)));
				return table.compLength != table.origLength
					? inflate(buffer)
					: bin.read(file, bin.Offset(table.offset, bin.Buffer(table.origLength)));
			}
		}
		me.sfntVersion = h.flavor;
		for (const {tag} of h.tables) {
			const buffer = await getTable(tag);
			if (buffer)
				me.loadTable(tag, buffer);
		}

		//glyph data
		const loca = await getTable("loca");
		const glyf = await getTable('glyf');
		if (loca && glyf)
			me.glyphdata = loadLocs(loca, glyf, me.head!.indexToLocFormat);

		//hmtx
		const hmtx = await getTable('hmtx');
		if (hmtx && me.hhea)
			me.hmtx = loadMetrics(hmtx, me.numGlyphs(), me.hhea!.numOfLongMetrics);

		return me;
	}

	// the font, whatever it was read from, as a file of this format: the tables an SFNT file would have, compressed
	static async write(font: Font) {
		const deflate = bin.compress('deflate');
		const {tables, header: directory, size: sfntSize} = layout(font);
		const tags = directory.tables.map(e => e.tag);
	
		const packed: Uint8Array[] = [];
		for (const tag of tags) {
			const data = tables.get(tag)!;
			const z = await deflate(data);
			packed.push(z.length < data.length ? z : data);
		}

		let offset = 44 + 20 * tags.length;
		const header = {
			signature:		0x774F4646,				// 'wOFF'
			flavor:			font.sfntVersion,
			length:			0,
			numTables:		tags.length,
			reserved:		0,
			totalSfntSize:	sfntSize,
			version:		font.head?.font_revision,
			metaOffset:		0,
			metaLength:		0,
			metaOrigLength:	0,
			privOffset:		0,
			privLength:		0,
			tables:			tags.map((tag, i) => {
				const entry = {tag, offset, compLength: packed[i].length, origLength: tables.get(tag)!.length, origChecksum: directory.tables[i].checksum};
				offset += (packed[i].length + 3) & ~3;
				return entry;
			}),
		};
		header.length = offset;
		const s = new bin.growingStream();
		bin.write(s, WOFFHeader, header);

		packed.forEach((b, i) => {
			s.seek(header.tables[i].offset);
			s.write_view(b);
		});
		s.write_view(new Uint8Array(header.length - s.tell()));		// the last table is padded too
		return s.terminate();
	}

	save() {
		return WOFF.write(this);
	}
}

//-----------------------------------------------------------------------------
//	WOFF2
//-----------------------------------------------------------------------------

const UShort255 = {
	get(s: bin._stream) {
		const code = u8.get(s);
		return	code == 253	? u16.get(s)
			:	code == 255	? u8.get(s) + 253
			:	code == 254	? u8.get(s) + 253 * 2
			:	code;
	},
	// a number up to 252 in a byte; then 253 and a word for any; or 255, or 254, and a byte, for those 253 to 505 or 506 to 758
	put(s: bin._stream, v: number) {
		if (v < 253) {
			u8.put(s, v);
		} else if (v < 506) {
			u8.put(s, 255);
			u8.put(s, v - 253);
		} else if (v < 759) {
			u8.put(s, 254);
			u8.put(s, v - 506);
		} else {
			u8.put(s, 253);
			u16.put(s, v);
		}
	}
};

const UIntBase128 = {
	get(s: bin._stream) {
		let accum = 0;
		for (let i = 0; i < 5; i++) {
			const byte = u8.get(s);
			accum = (accum << 7) | (byte & 0x7F);
			if ((byte & 0x80) == 0)
				return accum;
		}
		throw new Error("bad uint");
	},
	// seven bits at a time, the most significant first, each but the last with its top bit set
	put(s: bin._stream, v: number) {
		const bytes = [v % 128];
		for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128))
			bytes.unshift((v % 128) | 0x80);
		bin.writen(s, u8, bytes);
	}
};

function MC(xbits: number, xdelta: number, ybits: number, ydelta: number) { return {xbits, xdelta, ybits, ydelta}; }

const TripletEncodingTable = [
	MC( 0, 0,	-8, 0),		MC( 0, 0,	+8, 0),		MC( 0, 0,	-8, 256),	MC( 0, 0,	+8, 256),
	MC( 0, 0,	-8, 512),	MC( 0, 0,	+8, 512),	MC( 0, 0,	-8, 768),	MC( 0, 0,	+8, 768),
	MC( 0, 0,	-8, 1024),	MC( 0, 0,	+8, 1024),	MC(-8, 0,	 0, 0),		MC(+8, 0,	 0, 0),
	MC(-8, 256,	 0, 0),		MC(+8, 256,	 0, 0),		MC(-8, 512,	 0, 0),		MC(+8, 512,	 0, 0),
	MC(-8, 768,	 0, 0),		MC(+8, 768,	 0, 0),		MC(-8, 1024, 0, 0),		MC(+8, 1024, 0, 0),
	MC(-4, 1,	-4, 1),		MC(+4, 1,	-4, 1),		MC(-4, 1,	+4, 1),		MC(+4, 1,	+4, 1),
	MC(-4, 1,	-4, 17),	MC(+4, 1,	-4, 17),	MC(-4, 1,	+4, 17),	MC(+4, 1,	+4, 17),
	MC(-4, 1,	-4, 33),	MC(+4, 1,	-4, 33),	MC(-4, 1,	+4, 33),	MC(+4, 1,	+4, 33),
	MC(-4, 1,	-4, 49),	MC(+4, 1,	-4, 49),	MC(-4, 1,	+4, 49),	MC(+4, 1,	+4, 49),
	MC(-4, 17,	-4, 1),		MC(+4, 17,	-4, 1),		MC(-4, 17,	+4, 1),		MC(+4, 17,	+4, 1),
	MC(-4, 17,	-4, 17),	MC(+4, 17,	-4, 17),	MC(-4, 17,	+4, 17),	MC(+4, 17,	+4, 17),
	MC(-4, 17,	-4, 33),	MC(+4, 17,	-4, 33),	MC(-4, 17,	+4, 33),	MC(+4, 17,	+4, 33),
	MC(-4, 17,	-4, 49),	MC(+4, 17,	-4, 49),	MC(-4, 17,	+4, 49),	MC(+4, 17,	+4, 49),
	MC(-4, 33,	-4, 1),		MC(+4, 33,	-4, 1),		MC(-4, 33,	+4, 1),		MC(+4, 33,	+4, 1),
	MC(-4, 33,	-4, 17),	MC(+4, 33,	-4, 17),	MC(-4, 33,	+4, 17),	MC(+4, 33,	+4, 17),
	MC(-4, 33,	-4, 33),	MC(+4, 33,	-4, 33),	MC(-4, 33,	+4, 33),	MC(+4, 33,	+4, 33),
	MC(-4, 33,	-4, 49),	MC(+4, 33,	-4, 49),	MC(-4, 33,	+4, 49),	MC(+4, 33,	+4, 49),
	MC(-4, 49,	-4, 1),		MC(+4, 49,	-4, 1),		MC(-4, 49,	+4, 1),		MC(+4, 49,	+4, 1),
	MC(-4, 49,	-4, 17),	MC(+4, 49,	-4, 17),	MC(-4, 49,	+4, 17),	MC(+4, 49,	+4, 17),
	MC(-4, 49,	-4, 33),	MC(+4, 49,	-4, 33),	MC(-4, 49,	+4, 33),	MC(+4, 49,	+4, 33),
	MC(-4, 49,	-4, 49),	MC(+4, 49,	-4, 49),	MC(-4, 49,	+4, 49),	MC(+4, 49,	+4, 49),
	MC(-8, 1,	-8, 1),		MC(+8, 1,	-8, 1),		MC(-8, 1,	+8, 1),		MC(+8, 1,	+8, 1),
	MC(-8, 1,	-8, 257),	MC(+8, 1,	-8, 257),	MC(-8, 1,	+8, 257),	MC(+8, 1,	+8, 257),
	MC(-8, 1,	-8, 513),	MC(+8, 1,	-8, 513),	MC(-8, 1,	+8, 513),	MC(+8, 1,	+8, 513),
	MC(-8, 257,	-8, 1),		MC(+8, 257,	-8, 1),		MC(-8, 257,	+8, 1),		MC(+8, 257,	+8, 1),
	MC(-8, 257,	-8, 257),	MC(+8, 257,	-8, 257),	MC(-8, 257,	+8, 257),	MC(+8, 257,	+8, 257),
	MC(-8, 257,	-8, 513),	MC(+8, 257,	-8, 513),	MC(-8, 257,	+8, 513),	MC(+8, 257,	+8, 513),
	MC(-8, 513,	-8, 1),		MC(+8, 513,	-8, 1),		MC(-8, 513,	+8, 1),		MC(+8, 513,	+8, 1),
	MC(-8, 513,	-8, 257),	MC(+8, 513,	-8, 257),	MC(-8, 513,	+8, 257),	MC(+8, 513,	+8, 257),
	MC(-8, 513,	-8, 513),	MC(+8, 513,	-8, 513),	MC(-8, 513,	+8, 513),	MC(+8, 513,	+8, 513),
	MC(-12, 0,	-12, 0),	MC(+12, 0,	-12, 0),	MC(-12, 0,	+12, 0),	MC(+12, 0,	+12, 0),
	MC(-16, 0,	-16, 0),	MC(+16, 0,	-16, 0),	MC(-16, 0,	+16, 0),	MC(+16, 0,	+16, 0),
];

function decodeTriplet(flags: number, file: bin._stream): float2 {
	const e		= TripletEncodingTable[flags & 0x7f];
	const xbits	= Math.abs(e.xbits);
	const ybits = Math.abs(e.ybits);
	const value = Number(bin.UINT(xbits + ybits, true).get(file));
	const x		= e.xdelta + (value >> ybits);
	const y		= e.ydelta + (value & ((1 << ybits) - 1));
	return float2(e.xbits < 0 ? -x : x, e.ybits < 0 ? -y : y);
}


//@internal
export const KnownTags = [
	'cmap',	'head',	'hhea',	'hmtx',	'maxp',	'name',	'OS/2',	'post',
	'cvt ',	'fpgm',	'glyf',	'loca',	'prep',	'CFF ',	'VORG',	'EBDT',
	'EBLC',	'gasp',	'hdmx',	'kern',	'LTSH',	'PCLT',	'VDMX',	'vhea',
	'vmtx',	'BASE',	'GDEF',	'GPOS',	'GSUB',	'EBSC',	'JSTF',	'MATH',
	'CBDT',	'CBLC',	'COLR',	'CPAL',	'SVG ',	'sbix',	'acnt',	'avar',
	'bdat',	'bloc',	'bsln',	'cvar',	'fdsc',	'feat',	'fmtx',	'fvar',
	'gvar',	'hsty',	'just',	'lcar',	'mort',	'morx',	'opbd',	'prop',
	'trak',	'Zapf',	'Silf',	'Glat',	'Gloc',	'Feat',	'Sill',	'xxxx',
];

//@internal
export const WOFF2Header = {
	signature:		u32,	//0x774F4632 'wOF2'
	flavor:			TAG,	//The "sfnt version" of the input font.
	length:			u32,	//Total size of the WOFF file.
	numTables:		u16,	//Number of entries in directory of font tables.
	reserved:		u16,	//Reserved; set to zero.
	totalSfntSize:	u32,	//Total size needed for the uncompressed font data, including the sfnt header, directory, and font tables (including padding).
	totalCompressedSize: u32,	//Total length of the compressed data block.
	version:		u32,	//Major.Minor version of the WOFF file.
	metaOffset:		u32,	//Offset to metadata block, from beginning of WOFF file.
	metaLength:		u32,	//Length of compressed metadata block.
	metaOrigLength:	u32,	//Uncompressed size of metadata block.
	privOffset:		u32,	//Offset to private data block, from beginning of WOFF file.
	privLength:		u32,	//Length of private data block.

	tables:	bin.Array(s => s.obj.numTables, {
		flags:				u8,		//table type and flags
		tag:				bin.Switch(s => (s.obj.flags & 63) === 63 ? 1 : 0, {
			0: bin.Func(s => KnownTags[s.obj.flags & 63]),
			1: TAG,
		}),
		origLength:			UIntBase128,
		// transformed length (if applicable)
		transformLength:	bin.Optional(s => (s.obj.tag == 'glyf' || s.obj.tag == 'loca') === !(s.obj.flags >> 6), UIntBase128),
		data:				bin.Const(new Uint8Array() as Uint8Array),
	}),

	sub:	bin.Optional(s => s.obj.flavor === 'ttcf', {
		version:	u32,
		subs:		bin.Array(UShort255, {
			numTables:		UShort255,
			flavor:			u32,
			table_indices:	bin.Array(s => s.obj.numTables, UShort255),
		})
	}),
};

class WOFF2TransformedGlyf extends bin.Class({
	reserved:				u16,	// 0x0000
	optionFlags:			u16,	// Bit 0: if set, indicates the presence of the overlapSimpleBitmap[] bit array. Bits 1-15: Reserved.
	numGlyphs:				u16,	// Number of glyphs
	indexFormat:			u16,	// Offset format for loca table, should be consistent with indexToLocFormat of the original head table (see [OFF] specification)
	nContourStreamSize:		u32,	// Size of nContour stream in bytes
	nPointsStreamSize:		u32,	// Size of nPoints stream in bytes
	flagStreamSize:			u32,	// Size of flag stream in bytes
	glyphStreamSize:		u32,	// Size of glyph stream in bytes (a stream of variable-length encoded values, see description below)
	compositeStreamSize:	u32,	// Size of composite stream in bytes (a stream of variable-length encoded values, see description below)
	bboxStreamSize:			u32,	// Size of bbox data in bytes representing combined length of bboxBitmap (a packed bit array) and bboxStream (a stream of Int16 values)
	instructionStreamSize:	u32,	// Size of instruction stream (a stream of UInt8 values)
}) {
	glyphs:	Glyph[];

	constructor(file: bin.stream) {
		super(file);
		const nContourStream		= file.view(Uint8Array, this.nContourStreamSize);		//Stream of Int16 values representing number of contours for each glyph record
		const nPointsStream			= file.view(Uint8Array, this.nPointsStreamSize);		//Stream of values representing number of outline points for each contour in glyph records
		const flagStream			= file.view(Uint8Array, this.flagStreamSize);			//Stream of UInt8 values representing flag values for each outline point.
		const glyphStream			= file.view(Uint8Array, this.glyphStreamSize);			//Stream of bytes representing point coordinate values using variable length encoding format (defined in subclause 5.2)
		const compositeStream		= file.view(Uint8Array, this.compositeStreamSize);		//Stream of bytes representing component flag values and associated composite glyph data
		const bboxStream			= file.view(Uint8Array, this.bboxStreamSize);
		const instructionStream		= file.view(Uint8Array, this.instructionStreamSize);	//Stream of UInt8 values representing a set of instructions for each corresponding glyph
		const _overlapSimpleBitmap	= file.remainder();	//A numGlyphs-long bit array that provides values for the overlap flag [bit 6] for each simple glyph. (Flag values for composite glyphs are already encoded as part of the compositeStream[]).

		const nc	= Array.from(bin.typedArray.as(nContourStream, 'Int16', true));
		const nGlyphs = this.numGlyphs;

		const pfile = new bin.stream(nPointsStream);
		const ffile	= new bin.stream(flagStream);
		const gfile	= new bin.stream(glyphStream);
		const cfile	= new bin.stream(compositeStream);
		const ifile	= new bin.stream(instructionStream);
		const bfile	= new bin.stream(bboxStream);

		// which glyphs have a bounding box stored (the others' is worked out from their points): a bit each, the first
		// glyph in the top bit, in a bitmap padded to a multiple of four bytes, and then the boxes themselves
		const bboxBitmap = bin.read(bfile, bin.Buffer(4 * ((nGlyphs + 31) >> 5)));
		const bit = (map: Uint8Array, i: number) => !!(map[i >> 3] & (0x80 >> (i & 7)));
		const overlaps = (this.optionFlags & 1) ? _overlapSimpleBitmap : undefined;

		this.glyphs = nc.map((nc, index) => {
			let bbox = bit(bboxBitmap, index) ? bin.read(bfile, {min: vec2(s16), max: vec2(s16)}) : undefined;
			let instructions;

			if (nc < 0) {
				if (!bbox)
					throw new Error("a composite glyph has no bounding box");

				const {refs, have_instructions, overlap} = readComposite(cfile);
				if (have_instructions) {
					const ins = UShort255.get(gfile);
					instructions = bin.read(ifile, bin.Buffer(ins));
				}
				return {
					min: bbox.min,
					max: bbox.max,
					refs,
					instructions,
					overlap: overlap || undefined,
				} as Glyph;
			}

			const contours: {x: number, y: number, on: boolean}[][] = [];
			if (nc) {
				let	x = 0, y = 0;
				for (let c = 0; c < nc; c++) {
					const points: {x: number, y: number, on: boolean}[] = [];
					for (let i = UShort255.get(pfile); i > 0; i--) {
						const flags = u8.get(ffile);
						const d = decodeTriplet(flags, gfile);
						points.push({x: x += d.x, y: y += d.y, on: !(flags & 0x80)});		// the top bit of the flag is set for an off-curve point
					}
					contours.push(points);
				}
				const ins = UShort255.get(gfile);
				instructions = bin.read(ifile, bin.Buffer(ins));
			}

			// without a stored box it is the extent of the points, those off the curve too, as a stored one is
			if (!bbox) {
				const all = contours.flat();
				bbox = all.length
					? {min: float2(Math.min(...all.map(p => p.x)), Math.min(...all.map(p => p.y))), max: float2(Math.max(...all.map(p => p.x)), Math.max(...all.map(p => p.y)))}
					: {min: float2(0, 0), max: float2(0, 0)};
			}
			return {
				min: bbox.min,
				max: bbox.max,
				curve: contours.length ? contoursToCurve(contours) : undefined,
				instructions,
				overlap: overlaps && bit(overlaps, index) ? true : undefined,
			} as Glyph;
		});

	}
}

export class WOFF2 extends Font {
	metadata?:	xml.Element;
	priv?:		Uint8Array;

	static async load(file: bin.stream) {
		const me 	= new WOFF2;
		const h		= bin.read(file, WOFF2Header);
		const brotli = bin.decompress('brotli');

		if (h.metaLength) {
			const buffer = brotli(bin.read(file, bin.Offset(h.metaOffset, bin.Buffer(h.metaLength))));
			me.metadata = xml.parse(bin.text.decode(await buffer));
		}
		if (h.privLength) {
			const buffer = brotli(bin.read(file, bin.Offset(h.privOffset, bin.Buffer(h.privLength))));
			me.priv = await buffer;
		}

		const comp		= bin.read(file, bin.Buffer(h.totalCompressedSize));
		const uncomp	= await brotli(comp);

		let offset = 0;
		for (const i of h.tables) {
			const	start = offset;
		  	offset	+= i.transformLength ?? i.origLength;
			i.data	= uncomp.subarray(start, offset);
		}

		function findTable(tag: string) {
			return h.tables.find(i => i.tag === tag);
		}

		me.sfntVersion = [...h.flavor].reduce((v, c) => ((v << 8) | c.charCodeAt(0)) >>> 0, 0);
		// a transformed table is not the table's own bytes, so it is not kept as one. The version of the transform is in
		// the top bits of the flags: 0 is the transform for glyf and loca (3 is none), but none for the other tables.
		for (const table of h.tables) {
			const version = table.flags >> 6;
			if (version === (table.tag === 'glyf' || table.tag === 'loca' ? 3 : 0))
				me.loadTable(table.tag, table.data!);
		}

		//glyph data
		const loca = findTable("loca");
		const glyf = findTable('glyf');
		if (loca && glyf) {
			if ((glyf.flags & 0xc0) == 0) {
				const g = new WOFF2TransformedGlyf(new bin.stream(glyf.data!));
				me.cached	= g.glyphs;
				// there is no glyf to keep, so one is made from the glyphs (without their hinting) for the font to be
				// edited and written as any other is
				me.glyphdata = g.glyphs.map(gl => new GlyphSerialiser({curve: gl.curve, refs: gl.refs, min: gl.min, max: gl.max, overlap: gl.overlap}).toBytes());
			} else {
				me.glyphdata = loadLocs(loca.data!, glyf.data!, me.head!.indexToLocFormat);
			}
		}

		//hmtx
		const hmtx = findTable('hmtx');
		if (hmtx && me.hhea) {
			const	numGlyphs	= me.numGlyphs();
			const	numMetrics	= me.hhea.numOfLongMetrics;
			if (hmtx.flags & 0xc0) {
				const	hfile		= new bin.stream(hmtx.data!);
				const	flags		= u8.get(hfile);
				const	metrics 	= bin.readn(hfile, u16, numMetrics).map(i => ({advance: i, bearing: 0}));
				const	minxs		= me.cached.map(i => i!.min.x);

				(flags & 1 ? minxs.slice(0, numMetrics) : bin.readn(hfile, s16, numMetrics))
					.forEach((i, index) => metrics[index].bearing = i);

				const bearing = !(flags & 2) ? bin.readn(hfile, s16, numGlyphs - numMetrics)	: minxs.slice(numMetrics);
				me.hmtx = {metrics, bearing};

			} else {
				me.hmtx = loadMetrics(hmtx.data!, numGlyphs, numMetrics);
			}
		}
		return me;
	}

	// the font, whatever it was read from, as a file of this format: the tables an SFNT file would have, compressed
	static async write(font: Font) {
		const brotli = bin.compress('brotli');
		const {tables, size: sfntSize} = layout(font);
		// loca must follow glyf
		const tags = [...tables.keys()].filter(t => t !== 'loca');
		if (tables.has('loca'))
			tags.splice(tags.indexOf('glyf') + 1, 0, 'loca');
	
		const all = new Uint8Array(tags.reduce((n, t) => n + tables.get(t)!.length, 0));
		let at = 0;
		for (const tag of tags) {
			all.set(tables.get(tag)!, at);
			at += tables.get(tag)!.length;
		}
		const packed = await brotli(all);
		const flavorTag = (version: number) => String.fromCharCode(version >>> 24, (version >>> 16) & 255, (version >>> 8) & 255, version & 255);
	
		const header = {
			signature:				0x774F4632,		// 'wOF2'
			flavor:					flavorTag(font.sfntVersion),
			length:					0,
			numTables:				tags.length,
			reserved:				0,
			totalSfntSize:			sfntSize,
			totalCompressedSize:	packed.length,
			version:				font.head?.font_revision ?? 0,
			metaOffset:				0,
			metaLength:				0,
			metaOrigLength:			0,
			privOffset:				0,
			privLength:				0,
			tables:					tags.map(tag => {
				const known = KnownTags.indexOf(tag);
				// a known table is named by its number, and any other by 63 and its tag. The transform version is in the top
				// bits: 3 is none for glyf and loca (0 would be the glyf transform), 0 is none for the others.
				const version = tag === 'glyf' || tag === 'loca' ? 3 : 0;
				return {flags: (version << 6) | (known >= 0 ? known : 63), tag, origLength: tables.get(tag)!.length, transformLength: 0, data: new Uint8Array(0)};
			}),
			sub:					undefined,
		};

		// the header says how long the file is, and is as long whatever it says
		header.length = (bin.measure(WOFF2Header, header) + packed.length + 3) & ~3;

		const s = new bin.growingStream();
		bin.write(s, WOFF2Header, header);
		s.write_view(packed);
		s.write_view(new Uint8Array(header.length - s.tell()));		// the file's end is padded
		return s.terminate();
	}

	save() {
		return WOFF2.write(this);
	}
}
