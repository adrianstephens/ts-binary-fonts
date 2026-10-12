import * as bin from '@isopodlabs/binary';
import * as xml from '@isopodlabs/xml';
import { float2, float2x3 } from '@isopodlabs/maths/vector';
import { curveVertex, ON_BEGIN, ON_CURVE, OFF_BEZ2, bezier2Curve, parseCurve, transformCurve} from './curves';
import { makeSVG, makeSVGPath, SVGlayers, extractGlyphElement, mergeGlyphSVG } from './svg';

import {CFF} from "./cff";
import {CPAL, COLR} from "./colr";

// A component of a composite glyph. Only what the matrix cannot say is kept as flags; how its arguments are sized and
// which of the scale forms is used are worked out again when it is written.
export interface GlyphRef {
	glyph:			number;
	mat:			float2x3;
	match?:			[number, number];	// placed by making a point of the composite so far coincide with a point of this glyph, not by an offset (mat.z is then unused)
	useMyMetrics?:	boolean;			// the composite takes this component's advance and side bearing
	roundToGrid?:	boolean;			// the offset is rounded to the pixel grid when hinted
	scaledOffset?:	boolean;			// the offset is scaled by the component's matrix (Apple's way), not applied as it is (Microsoft's)
};

export interface Glyph {
	min:			float2;
	max:			float2;
	curve?:			curveVertex[];
	refs?:			GlyphRef[];
	instructions?:	Uint8Array;
	overlap?:		boolean;		// its contours (or components) may overlap, so a renderer should not assume they do not
};

export interface GlyphImage {
	originOffset:	float2;			//The position of the left edge of the bitmap graphic in relation to the glyph design space origin.
	type:			string,//'jpg '|'png '|'tiff'|'raw ',
	data:			Uint8Array;
};

function makeClass<I>() {
	return (class {} as new () => I);
}

function lowerBound<T>(array: T[], func: (a: T, i: number) => boolean) {
	let i = 0;
	for (let n = array.length; n; n >>= 1) {
		const mid = i + (n >> 1);
		if (func(array[mid], mid)) {
			i = mid + 1;
			--n;
		}
	}
	return i;
}

function argmin<T>(array: T[], fn?:(i: T) => number) {
	let mini	= 0;
	let minv	= fn ? fn(array[0]) : array[0];
	for (let i = 1; i < array.length; i++) {
		const v = fn ? fn(array[i]) : array[i];
		if (v < minv) {
			mini = i;
			minv = v;
		}
	}
	return mini;
}

function arrayReverse<T>(array: T[], start: number, end: number): void {
	while (start < end) {
		[array[start], array[end]] = [array[end], array[start]];
		start++;
		end--;
	}
}

function arrayRotate<T>(array: T[], start: number, end: number, shift: number): void {
	const length = end - start;
	if (length > 1 && shift % length) {
		shift = ((shift % length) + length) % length;
		arrayReverse(array, start, end - 1);
		arrayReverse(array, start, start + shift - 1);
		arrayReverse(array, start + shift, end - 1);
	}
}

function as<T, U = T>(type: bin.TypeT<U>) {
	return bin.as(type, i => i as T);
}
function asV<T extends {[key: string]: any}>(type: bin.TypeT<any>, values: T) {
	return bin.as(type, i => i as T[keyof T]);
}

//-----------------------------------------------------------------------------
//	TTF types
//-----------------------------------------------------------------------------

const timeAdjust = new Date('1970-01-01T00:00:00Z').getTime() - new Date('1904-01-01T00:00:00Z').getTime();

const datetime64 = bin.as(bin.INT64_BE, i => new Date(Number(i) * 1000 - timeAdjust), (d: Date) => BigInt(Math.round((d.getTime() + timeAdjust) / 1000)));
const TAG		= bin.String(4);
const u8 		= bin.UINT8;
const s8 		= bin.INT8;
const u16 		= bin.UINT16_BE;
const s16 		= bin.INT16_BE;
const u32 		= bin.UINT32_BE;
const u24		= bin.UINT(24, true);

// a signed 2.14 fixed-point number, a component's scale: the number of sixteen-thousandths it is, to write
const f2dot14	= bin.as(s16, (x: number) => x / 16384, (v: number) => {
	const n = Math.round(v * 16384);
	if (n < -32768 || n > 32767)
		throw new RangeError(`scale ${v} does not fit a component of a TrueType glyph`);
	return n;
});

//@internal
export function vec2(type: bin.TypeT<number>): bin.TypeT<float2> {
	return bin.as({x: type, y: type}, v => float2(v.x, v.y));
}

export const PLATFORM = {
	UNICODE:			0,	//Various
	MACINTOSH:			1,	//Script manager code
	ISO:				2,	//ISO encoding [deprecated]
	WINDOWS:			3,	//Windows encoding
	CUSTOM:				4,	//Custom
} as const;
export type PLATFORM = (typeof PLATFORM)[keyof typeof PLATFORM];

export const ENCODING = {
	UNI_default:		0,	//deprecated
	UNI_1_1:			1,	//deprecated
	UNI_iso_10646:		2,	//deprecated
	UNI_2_bmp:			3,	//Unicode BMP only
	UNI_2_full:			4,	//Unicode full repertoire
	UNI_variation:		5,	//for use with subtable format 14
	UNI_full:			6,	//for use with subtable format 13

	MAC_Roman:			0,
	MAC_Japanese:		1,
	MAC_TradChinese:	2,
	MAC_Korean:			3,
	MAC_Arabic:			4,
	MAC_Hebrew:			5,
	MAC_Greek:			6,
	MAC_Russian:		7,
	MAC_RSymbol:		8,
	MAC_Devanagari:		9,
	MAC_Gurmukhi:		10,
	MAC_Gujarati:		11,
	MAC_Oriya:			12,
	MAC_Bengali:		13,
	MAC_Tamil:			14,
	MAC_Telugu:			15,
	MAC_Kannada:		16,
	MAC_Malayalam:		17,
	MAC_Sinhalese:		18,
	MAC_Burmese:		19,
	MAC_Khmer:			20,
	MAC_Thai:			21,
	MAC_Laotian:		22,
	MAC_Georgian:		23,
	MAC_Armenian:		24,
	MAC_SimpChinese:	25,
	MAC_Tibetan:		26,
	MAC_Mongolian:		27,
	MAC_Geez:			28,
	MAC_Slavic:			29,
	MAC_Vietnamese:		30,
	MAC_Sindhi:			31,
	MAC_Uninterpreted:	32,

	ISO_ASCII7:			0,
	ISO_10646:			1,
	ISO_8859_1:			2,

	WIN_Symbol:			0,
	WIN_UCS2:			1,
	WIN_ShiftJIS:		2,
	WIN_PRC:			3,
	WIN_Big5:			4,
	WIN_Wansung:		5,
	WIN_Johab:			6,
	WIN_Reserved7:		7,
	WIN_Reserved8:		8,
	WIN_Reserved9:		9,
	WIN_UCS4:			10,
} as const;
export type ENCODING = (typeof ENCODING)[keyof typeof ENCODING];

//-----------------------------------------------------------------------------
//	OS/2
//-----------------------------------------------------------------------------

class PANOSE extends bin.Class({
	bFamilyType:		u8,
	bSerifStyle:		u8,
	bWeight:			u8,
	bProportion:		u8,
	bContrast:			u8,
	bStrokeVariation:	u8,
	bArmStyle:			u8,
	bLetterform:		u8,
	bMidline:			u8,
	bXHeight:			u8,
}) {}

const OS2 = {
	version:			u16,			//0x0004
	avg_char_width:		s16,
	weight_class:		u16,
	width_class:		u16,
	type:				u16,
	subscript_size:		vec2(s16),
	subscript_offset:	vec2(s16),
	superscript_size:	vec2(s16),
	superscript_offset:	vec2(s16),
	strikeout_size:		s16,
	strikeout_position:	s16,
	family_class:		s16,
	panose:				PANOSE,
	unicode_range:		bin.Array(4, u32),
	vend_id:			bin.String(4),
	selection:			u16,
	first_char_index:	u16,
	last_char_index:	u16,
	//v0
	typo_ascender:		s16,
	typo_descender:		s16,
	typo_line_gap:		s16,
	win_ascent:			u16,
	win_descent:		u16,
	//v1
	_: bin.If(s => s.obj.version >= 1, {
		codepage_range:		bin.Array(2, u32),
	//v2,3,4
		_: bin.If(s => s.obj.version >= 2, {
			height:				s16,
			cap_height:			s16,
			default_char:		u16,
			break_char:			u16,
			max_context:		u16,
	//v5
			_: bin.If(s => s.obj.version >= 5, {
				LowerOpticalPointSize:	u16,
				UpperOpticalPointSize:	u16,
			})
		})
	})
};

//-----------------------------------------------------------------------------
// The start of an SFNT file (TrueType or OpenType): its version, and a record of where each table is
//-----------------------------------------------------------------------------

//@internal
export class SFNTHeader extends bin.Class({
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
	getTable(tag: string, file: bin.async._stream):	bin.MaybePromise<Uint8Array>| undefined;
	getTable(tag: string, file: bin.stream|bin.async._stream) {
		const table = this.tables.find(i => i.tag === tag);
		if (table)
			return file.view_at(Uint8Array, table.offset, table.length);
	}
};

//-----------------------------------------------------------------------------
//	head	(TTF + OTF)
//-----------------------------------------------------------------------------

const headFLAGS = {
	ybaseline: 			1 << 0,	// - y value of 0 specifies baseline
	xlsb:				1 << 1,	// - x position of left most black bit is LSB
	scaled_differ:		1 << 2,	// - scaled point size and actual point size will differ (i.e. 24 point glyph differs from 12 point glyph scaled by factor of 2)
	int_scale:			1 << 3,	// - use integer scaling instead of fractional
	ms0:				1 << 4,	// - (used by the Microsoft implementation of the TrueType scaler)
	vertical:			1 << 5,	// - This bit should be set in fonts that are intended to e laid out vertically, and in which the glyphs have been drawn such that an x-coordinate of 0 corresponds to the desired vertical baseline.
//:						1 << 6,	// - This bit must be set to zero.
	arabic:				1 << 7,	// - This bit should be set if the font requires layout for correct linguistic rendering (e.g. Arabic fonts).
	metamorphosis:		1 << 8,	// - This bit should be set for a GX font which has one or more metamorphosis effects designated as happening by default.
	strong_rl:			1 << 9,	// - This bit should be set if the font contains any strong right-to-left glyphs.
	indic:				1 << 10,// - This bit should be set if the font contains Indic-style rearrangement effects.
//:						1 << 11,// - Defined by Adobe.
//:						1 << 12,// - Defined by Adobe.
} as const;
//export type headFLAGS = typeof headFLAGS[keyof typeof headFLAGS];

const headSTYLE = {
	bold:				1 << 0,
	italic:				1 << 1,
	underline:			1 << 2,
	outline:			1 << 3,
	shadow:				1 << 4,
	condensed:			1 << 5,
	extended:			1 << 6,
} as const;
//export type headSTYLE = typeof headSTYLE[keyof typeof headSTYLE];

const headDIRECTION = {
	LEFTRIGHT_STRONG:	1,	// Only strongly left to right glyphs
	LEFTRIGHT:			2,	// Like 1 but also contains neutrals
	RIGHTLEFT_STRONG:	-1,	// Only strongly right to left glyphs
	RIGHTLEFT:			-2,	// Like -1 but also contains neutrals
} as const;
//export type headDIRECTION = typeof headDIRECTION[keyof typeof headDIRECTION];

//@internal
export class head extends bin.Class({
	version:			u32,		//0x00010000 if (version 1.0)
	font_revision:		u32,		//set by font manufacturer
	checksum_adj:		u32,		//To compute: set it to 0, calculate the checksum for the 'head' table and put it in the table directory, sum the entire font as u32, then store B1B0AFBA - sum. The checksum for the 'head' table will not be wrong. That is OK.
	magic:				u32,		//set to 0x5F0F3CF5
	flags:				asV(u16, headFLAGS),
	units_per_em:		u16,		//range from 64 to 16384
	created:			datetime64,	//international date
	modified:			datetime64,	//international date
	//for all glyph bounding boxes
	min:				vec2(s16),
	max:				vec2(s16),
	macStyle:			asV(u16, headSTYLE),
	lowestRecPPEM:		u16,		//smallest readable size in pixels
	fontDirectionHint:	asV(s16, headDIRECTION),		//0 Mixed directional glyphs
	indexToLocFormat:	s16,		//0 for short offsets, 1 for long
	glyphDataFormat:	s16,		//0 for current format
}) {}

//@internal
export function loadLocs(loca: Uint8Array, glyf: Uint8Array, indexToLocFormat: number) {
	const locs = indexToLocFormat === 0
		? Array.from(bin.typedArray.as(loca, 'Uint16', true)).map(i => i * 2)
		: Array.from(bin.typedArray.as(loca, 'Uint32', true));

	return locs.slice(0, -1).map((loc: number, i: number) => glyf.subarray(loc, locs[i + 1]));
}

//-----------------------------------------------------------------------------
//	hhea	Horizontal Header Table	+ hmtx	(TTF + OTF)
//	vhea	Vertical Header Table	+ vmtx
//-----------------------------------------------------------------------------

//@internal
export class MetricsHead extends bin.Class({
	version:				u32,	//0x00010000 (1.0)
	ascent:					s16,	//Distance from baseline of highest ascender
	descent:				s16,	//Distance from baseline of lowest descender
	lineGap:				s16,	//typographic line gap
	advanceMax:				u16,	//must be consistent with horizontal metrics
	minASideBearing:		s16,	//must be consistent with horizontal metrics
	minBSideBearing:		s16,	//must be consistent with horizontal metrics
	maxExtent:				s16,	//max(lsb + (xMax-xMin))
	caretSlopeRise:			s16,	//used to calculate the slope of the caret (rise/run) set to 1 for vertical caret
	caretSlopeRun:			s16,	//0 for vertical
	caretOffset:			s16,	//set value to 0 for non-slanted fonts
	reserved:				bin.Array(4, s16),			//set value to 0
	metricDataFormat:		s16,	//0 for current format
	numOfLongMetrics:		u16,	//number of advance widths in metrics table
}) {}

export interface Metrics {
	metrics: {
		advance:	number,
		bearing:	number,
	}[],
	bearing: 		number[],
};

//@internal
export function loadMetrics(data: Uint8Array, numGlyphs: number, numMetrics: number): Metrics {
	const	hfile	= new bin.stream(data);
	return {
		metrics:	bin.readn(hfile, {advance: u16, bearing: s16}, numMetrics),
		bearing:	bin.readn(hfile, s16, numGlyphs - numMetrics)
	};
}
//@internal
export function saveMetrics(m: Metrics) {
	const s = new bin.growingStream();
	bin.writen(s, {advance: u16, bearing: s16}, m.metrics);
	bin.writen(s, s16, m.bearing);
	return s.terminate();
}

//-----------------------------------------------------------------------------
//	maxp	Maximum Profile (TTF)
//-----------------------------------------------------------------------------

export const maxp = {
	version:				u32,	//0x00010000 (1.0)
	numGlyphs:				u16,	//the number of glyphs in the font
	_: bin.If(s => s.obj.version >= 0x00010000, {
		maxPoints:				u16,	//points in non-compound glyph
		maxContours:			u16,	//contours in non-compound glyph
		maxComponentPoints:		u16,	//points in compound glyph
		maxComponentContours:	u16,	//contours in compound glyph
		maxZones:				u16,	//set to 2
		maxTwilightPoints:		u16,	//points used in Twilight Zone (Z0)
		maxStorage:				u16,	//number of Storage Area locations
		maxFunctionDefs:		u16,	//number of FDEFs
		maxInstructionDefs:		u16,	//number of IDEFs
		maxStackElements:		u16,	//maximum stack depth
		maxSizeOfInstructions:	u16,	//byte count for glyph instructions
		maxComponentElements:	u16,	//number of glyphs referenced at top level
		maxComponentDepth:		u16,	//levels of recursion, set to 0 if font has only simple glyphs
	}),
};

//-----------------------------------------------------------------------------
//	name	Naming Table	(TTF + OTF)
//-----------------------------------------------------------------------------

export const ID = {
	COPYRIGHT:		0,	//Copyright notice.
	FAMILY:			1,	//Font Family. This string is the font family name the user sees on Macintosh platforms.
	SUBFAMILY:		2,	//Font Subfamily. This string is the font family the user sees on Macintosh platforms.
	IDENTIFICATION:	3,	//Unique subfamily identification.
	FULLNAME:		4,	//Full name of the font.
	VERSION:		5,	//Version of the name table.
	PS_NAME:		6,	//PostScript name of the font. Note: A font may have only one PostScript name and that name must be ASCII.
	TRADEMARK:		7,	//Trademark notice.
	MANUFACTURER:	8,	//Manufacturer name.
	DESIGNER:		9,	//Designer; name of the designer of the typeface.
	DESCRIPTION:	10,	//Description; description of the typeface. Can contain revision information, usage recommendations, history, features, and so on.
	VENDOR_URL:		11,	//URL of the font vendor (with procotol, e.g., http://, ftp://). If a unique serial number is embedded in the URL, it can be used to register the font.
	DESIGNER_URL:	12,	//URL of the font designer (with protocol, e.g., http://, ftp://)
	LICENSE:		13,	//License description; description of how the font may be legally used, or different example scenarios for licensed use. This field should be written in plain language, not legalese.
	LICENSE_URL:	14,	//License information URL, where additional licensing information can be found.
	RESERVED:		15,	//Reserved
	PREF_FAMILY:	16,	//Preferred Family (Windows only); In Windows, the Family name is displayed in the font menu; the Subfamily name is presented as the Style name. For historical reasons, font families have contained a maximum of four styles, but font designers may group more than four fonts to a single family. The Preferred Family and Preferred Subfamily IDs allow font designers to include the preferred family/subfamily groupings. These IDs are only present if they are different from IDs 1 and 2.
	PREF_SUBFAMILY:	17,	//Preferred Subfamily (Windows only); In Windows, the Family name is displayed in the font menu; the Subfamily name is presented as the Style name. For historical reasons, font families have contained a maximum of four styles, but font designers may group more than four fonts to a single family. The Preferred Family and Preferred Subfamily IDs allow font designers to include the preferred family/subfamily groupings. These IDs are only present if they are different from IDs 1 and 2.
	COMPATIBLE:		18,	//Compatible Full (Macintosh only); On the Macintosh, the menu name is constructed using the FOND resource. This usually matches the Full Name. If you want the name of the font to appear differently than the Full Name, you can insert the Compatible Full Name in ID 18. This name is not used by the Mac OS itself, but may be used by application developers (e.g., Adobe).
	SAMPLE:			19,	//Sample text. This can be the font name, or any other text that the designer thinks is the best sample text to show what the font looks like.
	//20 - 255	Reserved for future expansion.
	FONT_SPECIFIC:	256,	// 256 - 32767	Font-specific names (layout features and settings, variations, track names, etc.)
} as const;
export type ID = (typeof ID)[keyof typeof ID];

export class name extends bin.ReadClass({
	format:			u16,	//Format selector. Set to 0.
	count:			u16,	//The number of nameRecords in this name table.
	stringOffset:	u16,	//Offset in bytes to the beginning of the name character strings.
	names:	bin.Array('count', {
		platformID:		asV(u16, PLATFORM),	//Platform identifier code.
		encodingID:		asV(u16, ENCODING),	//Platform-specific encoding identifier.
		languageID:		u16,						//Language identifier.
		nameID:			asV(u16, ID),			//Name identifier
		length:			u16,						//Name string length in bytes
		offset:			u16,						//Name string offset in bytes from stringOffset.
		// three hops, not two: readn() (bin.Array's element loop) pushes the array itself as an intermediate .obj
		// frame around each record, so from within a record .obj is the record, .obj.obj is the names array, and
		// .obj.obj.obj is the outer name table that actually has stringOffset
		name: bin.Offset(s =>
			s.obj.obj.obj.stringOffset + s.obj.offset, bin.Switch(s => s.obj.platformID, {
			[PLATFORM.MACINTOSH]: bin.String(
				s => s.obj.length),
			[PLATFORM.WINDOWS]: bin.Switch(s =>
				s.obj.encodingID, {
				[ENCODING.WIN_UCS2]: bin.String(s => s.obj.length, 'utf16be', false, 1),
				[ENCODING.WIN_UCS4]: bin.String(s => s.obj.length, 'utf32be', false, 1),
			}),
			[PLATFORM.UNICODE]: bin.String(s => s.obj.length),
		})),
	}),
}) {
	get(nameID: ID, platformID?: PLATFORM, encodingID?: ENCODING, languageID?: number) {
		const record = this.names.find(i =>
			i.nameID === nameID
			&& (platformID === undefined || i.platformID === platformID)
			&& (encodingID === undefined || i.encodingID === encodingID)
			&& (languageID === undefined || i.languageID === languageID)
		);
		return record?.name;
	}
}

//-----------------------------------------------------------------------------
//	cmap	Character to Glyph Index Mapping Table	(TTF + OTF)
//-----------------------------------------------------------------------------

const cmapGroup = {
	start: u32, end: u32, glyph: u32
};

interface cmapTable {
	map(): number[];
}

const cmap_format_header1 = {
	length:		u16,	//Length in bytes of the subtable (set to 262 for format 0)
	language:	u16,	//Language code for this encoding subtable, or zero if language-independent
};

const cmap_format_header2 = {
	format_low:	u16,	//Subtable format; set to 8.0,10.0,12.0
	length:		u32,	//Byte length of this subtable (including the header)
	language:	u32,	//Language code for this encoding subtable, or zero if language-independent
};

class cmapByteEncoding extends bin.Class({...cmap_format_header1,
	glyphs:	bin.Array(256, u8),	//An array that maps character codes to glyph index values
}) implements cmapTable {
	map() {
		return this.glyphs;
	}
}

class cmapHighByteTable extends bin.Class({...cmap_format_header1,
	subHeaderKeys:	bin.Array(256, u16),		//Array that maps high bytes to subHeaders: value is index * 8
	data:		bin.Remainder,
}) implements cmapTable {
	map() {
	//subHeaders:		binary.RemainingArray({
	//	start:	u16,
	//	count:	u16,
	//	delta:	s16,
	//	range:	binary.Offset(u16,u16),
	//})
		const map: number[] = [];
		for (let i = 0; i < 256; i++) {
			const	offset	= this.subHeaderKeys[i] + 256 * 2;
			const	sub		= bin.read(new bin.stream(this.data.slice(offset)), {
				start:	u16,
				count:	u16,
				delta:	s16,
				range:	u16,
			});
			const	coffset	= i * 256 + sub.start;
			const	glyphs	= bin.typedArray.as(this.data.slice(offset + sub.range, sub.count * 2), 'Uint16', true);
			for (let c = 0; c < sub.count; c++)
				map[c + coffset] = (glyphs[c] + sub.delta) & 0xffff;
		}
		return map;
	}
};

class cmapSegmentDelta extends bin.Class({...cmap_format_header1,
	segCountX2: 	u16,			//2 * segCount
	searchRange: 	u16,			//2 * (2**FLOOR(log2(segCount)))
	entrySelector: 	u16,			//log2(searchRange/2)
	rangeShift: 	u16,			//(2 * segCount) - searchRange
	endCode: 		bin.RemainingArray(u16),			//Ending character code for each segment, last = 0xFFFF.
}) implements cmapTable {
/*
	u16	endCode[segCount];			//Ending character code for each segment, last = 0xFFFF.
	u16	reservedPad;				//This value should be zero
	u16	startCode[segCount];		//Starting character code for each segment
	u16	idDelta[segCount];			//Delta for all character codes in segment
	u16	idRangeOffset[segCount];	//Offset in bytes to glyph indexArray, or 0
	u16	glyphIndexArray[variable];	//Glyph index array
*/
	map() {
		const map: number[] = [];
		const count = this.segCountX2 / 2;
		const ends	= this.endCode;
		for (let i = 0; i < count; i++) {
			const r		= i + 1 + count * 3;
			const end	= ends[i];
			const start = ends[i + 1 + count * 1];
			const delta	= ends[i + 1 + count * 2];

			if (ends[r]) {
				const glyphs = ends.slice(r + ends[r] / 2);
				for (let c = start; c <= end; c++)
					map[c] = glyphs[c - start];
			} else {
				for (let c = start; c <= end; c++)
					map[c] = (c + delta) & 0xffff;
			}
		}
		return map;
	}
};

class cmapTrimmedMapping extends bin.Class({...cmap_format_header1,
	start:			u16,	//First character code of subrange
	glyphs:			bin.Array(u16, u16),	//Array of glyph index values for character codes in the range
}) implements cmapTable {
	map() {
		const map: number[] = [];
		this.glyphs.forEach((i, x) => map[x + this.start] = i);
		return map;
	}
}

class cmapMixed1632 extends bin.Class({...cmap_format_header2,
	is32:		bin.Array(8192, u8),			//Tightly packed array of bits (8K bytes total) indicating whether the particular 16-bit (index) value is the start of a 32-bit character code
	groups:		bin.Array(u32, cmapGroup),
}) implements cmapTable {
	//bool		is32bit(uint16 c)	const	{ return is32[c / 8] & (1 << (~c & 7)); }
	map() {
		const map: number[] = [];
		return map;
	}
}

class cmapTrimmedArray extends bin.Class({...cmap_format_header2,
	start:	u32,	//First character code covered
	glyphs:	bin.Array(u32, u16),	//Array of glyph indices for the character codes covered
}) implements cmapTable {
	map() {
		const map: number[] = [];
		this.glyphs.forEach((i, x) => map[x + this.start] = i);
		return map;
	}
}

class cmapSegmented extends bin.Class({...cmap_format_header2,
	groups:	bin.Array(u32, cmapGroup),
}) implements cmapTable {
	map() {
		const map: number[] = [];
		for (const g of this.groups) {
			const	offset = g.glyph - g.start;
			for (let c = g.start; c <= g.end; c++)
				map[c] = c + offset;
		}
		return map;
	}
}

class cmapManyToOne extends bin.Class({...cmap_format_header2,
	groups:	bin.Array(u32, cmapGroup),
}) implements cmapTable {
	map() {
		const map: number[] = [];
		for (const g of this.groups) {
			for (let c = g.start; c <= g.end; c++)
				map[c] = g.glyph;
		}
		return map;
	}
}

class cmapVariationSeq extends bin.Class({
	length:	u32,
	variations:	bin.Array(u32, {
		selector:	u24,
		default_uvs:		bin.Offset(u32, {
			ranges:		bin.Array(u32, bin.as(u32, bin.bitfields.BitFields(32, {startUnicodeValue: 24, additionalCount: 8})))
		}, true),
		non_default_uvs:	bin.Offset(u32, {
			mappings:	bin.Array(u32, {unicodeValue: u24, glyphID: u16})
		}, true),
	}),
}) implements cmapTable {
	constructor(s: bin.stream) {
		super(s);
	}
	map() {
		const map: number[] = [];
		return map;
	}
}

const cmap = {
	ver:	u16,	//0
	tables:	bin.Array(u16, {
		platform:	u16,
		encoding:	u16,
		data:		as<cmapTable>(bin.Offset(u32, bin.Switch(u16, {
			0: 	cmapByteEncoding,
			2: 	cmapHighByteTable,
			4: 	cmapSegmentDelta,
			6: 	cmapTrimmedMapping,
			8: 	cmapMixed1632,
			10:	cmapTrimmedArray,
			12:	cmapSegmented,
			13:	cmapManyToOne,
			14:	cmapVariationSeq,
		}))),
	})
};

//-----------------------------------------------------------------------------
//	gasp	Grid-fitting and Scan-conversion Procedure Table	(mostly TTF)
//-----------------------------------------------------------------------------

const gaspBehavior = {
	grid_fit:	1,	//Use gridfitting
	do_gray:	2,	//Use grayscale rendering
} as const;
//export type gaspBehavior = typeof gaspBehavior[keyof typeof gaspBehavior];

const gasp = {
	version:	u16,	//Version number (set to 0)
	entries:	bin.Array(u16, {	//Sorted by ppem
		mac_ppem: u16,	//Upper limit of range, in PPEM
		behavior: asV(u16, gaspBehavior),	//Flags describing desired rasterizer behavior.
	})
};

//-----------------------------------------------------------------------------
//	glyf	Glyph Data	(usually TTF)
//-----------------------------------------------------------------------------

const INSTRUCTION = {
	AA:			0x7f,	// Adjust Angle
	ABS:		0x64,	// ABSolute value
	ADD:		0x60,	// ADD
	ALIGNPTS:	0x27,	// ALIGN Points
	ALIGNRP:	0x3c,	// ALIGN to Reference Point
	AND:		0x5c,	// logical AND
	CALL:		0x2b,	// CALL function
	CEILING:	0x67,	// CEILING
	CINDEX:		0x25,	// Copy the INDEXed element to the top of the stack
	CLEAR:		0x22,	// CLEAR the stack
	DEBG:		0x4f,	// DEBUG call
	DELTAC1:	0x73,	// DELTA exception C1
	DELTAC2:	0x74,	// DELTA exception C2
	DELTAC3:	0x75,	// DELTA exception C3
	DELTAP1:	0x5d,	// DELTA exception P1
	DELTAP2:	0x71,	// DELTA exception P2
	DELTAP3:	0x72,	// DELTA exception P3
	DEPTH:		0x24,	// DEPTH of the stack
	DIV:		0x62,	// DIVide
	DUP:		0x20,	// DUPlicate top stack element
	EIF:		0x59,	// End IF
	ELSE:		0x1b,	// ELSE clause
	ENDF:		0x2d,	// END Function definition
	EQ:			0x54,	// EQual
	EVEN:		0x57,	// EVEN
	FDEF:		0x2c,	// Function DEFinition
	FLIPOFF:	0x4e,	// set the auto FLIP Boolean to OFF
	FLIPON:		0x4d,	// set the auto FLIP Boolean to ON
	FLIPPT:		0x80,	// FLIP PoinT
	FLIPRGOFF:	0x82,	// FLIP RanGe OFF
	FLIPRGON:	0x81,	// FLIP RanGe ON
	FLOOR:		0x66,	// FLOOR
	GC:			0x46,	//-0x47[a] Get Coordinate projected onto the projection vector
	GETINFO:	0x88,	// GET INFOrmation
	GFV:		0x0d,	// Get Freedom Vector
	GPV:		0x0c,	// Get Projection Vector
	GT:			0x52,	// Greater Than
	GTEQ:		0x53,	// Greater Than or EQual
	IDEF:		0x89,	// Instruction DEFinition
	IF:			0x58,	// IF test
	INSTCTRL:	0x8e,	// INSTRuction execution ConTRoL
	IP:			0x39,	// Interpolate Point
	ISECT:		0x0f,	// moves point p to the InterSECTion of two lines
	IUP:		0x30,	//-0x31[a] Interpolate Untouched Points through the outline
	JMPR:		0x1c,	// JuMP Relative
	JROF:		0x79,	// Jump Relative On False
	JROT:		0x78,	// Jump Relative On True
	LOOPCALL:	0x2a,	// LOOP and CALL function
	LT:			0x50,	// Less Than
	LTEQ:		0x51,	// Less Than or Equal
	MAX:		0x8b,	// MAXimum of top two stack elements
	MD:			0x49,	//-0x4a[a] Measure Distance
	MDAP:		0x2e,	//-0x2f[a] Move Direct Absolute Point
	MDRP:		0xc0,	//-0xdf[abcde] Move Direct Relative Point
	MIAP:		0x3e,	//-0x3f[a] Move Indirect Absolute Point
	MIN:		0x8c,	// MINimum of top two stack elements
	MINDEX:		0x26,	// Move the INDEXed element to the top of the stack
	MIRP:		0xe0,	//-0xff[abcde] Move Indirect Relative Point
	MPPEM:		0x4b,	// Measure Pixels Per EM
	MPS:		0x4c,	// Measure Point Size
	MSIRP:		0x3a,	//-0x3b[a] Move Stack Indirect Relative Point
	MUL:		0x63,	// MULtiply
	NEG:		0x65,	// NEGate
	NEQ:		0x55,	// Not EQual
	NOT:		0x5c,	// logical NOT
	NPUSHB:		0x40,	// PUSH N Bytes
	NPUSHW:		0x41,	// PUSH N Words
	NROUND:		0x6c,	//-0x6f[ab] No ROUNDing of value
	ODD:		0x56,	// ODD
	OR:			0x5b,	// logical OR
	POP:		0x21,	// POP top stack element
	PUSHB:		0xb0,	//-0xb7[abc] PUSH Bytes
	PUSHW:		0xb8,	//-0xbf[abc] PUSH Words
	RCVT:		0x45,	// Read Control Value Table entry
	RDTG:		0x7d,	// Round Down To Grid
	ROFF:		0x7a,	// Round OFF
	ROLL:		0x8a,	//ROLL the top three stack elements
	ROUND:		0x68,	//-0x6b[ab] ROUND value
	RS:			0x43,	// Read Store
	RTDG:		0x3d,	// Round To Double Grid
	RTG:		0x18,	// Round To Grid
	RTHG:		0x19,	// Round To Half Grid
	RUTG:		0x7c,	// Round Up To Grid
	S45ROUND:	0x77,	// Super ROUND 45 degrees
	SANGW:		0x7e,	// Set Angle Weight
	SCANCTRL:	0x85,	// SCAN conversion ConTRoL
	SCANTYPE:	0x8d,	// SCANTYPE
	SCFS:		0x48,	// Sets Coordinate From the Stack using projection vector and freedom vector
	SCVTCI:		0x1d,	// Set Control Value Table Cut-In
	SDB:		0x5e,	// Set Delta Base in the graphics state
	SDPVTL:		0x86,	//-0x87[a] Set Dual Projection Vector To Line
	SDS:		0x5f,	// Set Delta Shift in the graphics state
	SFVFS:		0x0b,	// Set Freedom Vector From Stack
	SFVTCA:		0x04,	//-0x05[a] Set Freedom Vector To Coordinate Axis
	SFVTL:		0x08,	//-0x09[a] Set Freedom Vector To Line
	SFVTP:		0x0e,	// Set Freedom Vector To Projection Vector
	SHC:		0x34,	//-0x35[a] SHift Contour using reference point
	SHP:		0x32,	//-0x33[a] SHift Point using reference point
	SHPIX:		0x38,	// SHift point by a PIXel amount
	SHZ:		0x36,	//-0x37[a] SHift Zone using reference point
	SLOOP:		0x17,	// Set LOOP variable
	SMD:		0x1a,	// Set Minimum Distance
	SPVFS:		0x0a,	// Set Projection Vector From Stack
	SPVTCA:		0x02,	//-0x03[a] Set Projection Vector To Coordinate Axis
	SPVTL:		0x06,	//-0x07[a] Set Projection Vector To Line
	SROUND:		0x76,	// Super ROUND
	SRP0:		0x10,	// Set Reference Point 0
	SRP1:		0x11,	// Set Reference Point 1
	SRP2:		0x12,	// Set Reference Point 2
	SSW:		0x1f,	// Set Single Width
	SSWCI:		0x1e,	// Set Single Width Cut-In
	SUB:		0x61,	// SUBtract
	SVTCA:		0x00,	//-0x01[a] Set freedom and projection Vectors To Coordinate Axis
	SWAP:		0x23,	// SWAP the top two elements on the stack
	SZP0:		0x13,	// Set Zone Pointer 0
	SZP1:		0x14,	// Set Zone Pointer 1
	SZP2:		0x15,	// Set Zone Pointer 2
	SZPS:		0x16,	// Set Zone PointerS
	UTP:		0x29,	// UnTouch Point
	WCVTF:		0x70,	// Write Control Value Table in Funits
	WCVTP:		0x44,	// Write Control Value Table in Pixel units
	WS:			0x42,	// Write Store
} as const;
type INSTRUCTION = typeof INSTRUCTION[keyof typeof INSTRUCTION];

const SIMPLE = {
	ON_CURVE:			1 << 0,	//If set, the point is on the curve;Otherwise, it is off the curve.
	SHORT_X:			1 << 1,	//the corresponding x-coordinate is 1 byte
	SHORT_Y:			1 << 2,	//the corresponding y-coordinate is 1 byte
	REPEAT:				1 << 3,	//If set, the next byte specifies the number of additional times this set of flags is to be repeated
	SAME_X:				1 << 4,	//If short_x, this is a sign bit (clear is -ve); else if set the current x is the same as the previous x
	SAME_Y:				1 << 5,	//If short_y, this is a sign bit (clear is -ve); else if set the current y is the same as the previous y
	OVERLAP:			1 << 6,	//contours in the glyph description could overlap. When used, it must be set on the first flag byte for the glyph
} as const;

const COMPOUND = {
	ARG12_WORDS:		1 << 0,	//the arguments are words; else they are bytes.
	ARGS_XY:			1 << 1,	//the arguments are xy values; else they are points.
	ROUND_TO_GRID:		1 << 2,	//round the xy values to grid
	HAVE_SCALE:			1 << 3,	//there is a simple scale for the component
	MORE_COMPONENTS:	1 << 5,	//at least one additional glyph follows this one.
	X_AND_Y_SCALE:		1 << 6,	//the x direction will use a different scale than the y direction.
	TWO_BY_TWO:			1 << 7,	//there is a 2-by-2 transformation
	HAVE_INSTRUCTIONS:	1 << 8,	//instructions for the component character follow the last component.
	USE_MY_METRICS:		1 << 9,	//Use metrics from this component for the compound glyph.
	OVERLAP:			1 << 10,	//the components of this compound glyph overlap.
	SCALED_OFFSET:		1 << 11,	//the offset is scaled by the component's matrix.
	UNSCALED_OFFSET:	1 << 12,	//the offset is not scaled (the default).
} as const;

class Instructions extends Uint8Array {
	[index: number]: INSTRUCTION;
};


//@internal
export const COMPONENT = COMPOUND;

//@internal
export function readComposite(file: bin.stream) {
	const refs: GlyphRef[] = [];
	let all_flags = 0, overlap = false;
	for (;;) {
		const	flags	= bin.read(file, u16);
		const	index	= bin.read(file, u16);
		all_flags	|= flags;
		overlap		||= !!(flags & COMPOUND.OVERLAP);

		const ref: GlyphRef = {glyph: index, mat: float2x3.identity()};
		// the two arguments: an offset (signed) or a pair of point numbers (unsigned), a byte each or a word each
		const words = !!(flags & COMPOUND.ARG12_WORDS);
		if (flags & COMPOUND.ARGS_XY)
			ref.mat.z = words ? float2(bin.read(file, s16), bin.read(file, s16)) : float2(bin.read(file, s8), bin.read(file, s8));
		else
			ref.match = words ? [bin.read(file, u16), bin.read(file, u16)] : [bin.read(file, u8), bin.read(file, u8)];

		if (flags & COMPOUND.HAVE_SCALE) {
			ref.mat.x.x = ref.mat.y.y = bin.read(file, f2dot14);
		} else if (flags & COMPOUND.X_AND_Y_SCALE) {
			ref.mat.x.x = bin.read(file, f2dot14);
			ref.mat.y.y = bin.read(file, f2dot14);
		} else if (flags & COMPOUND.TWO_BY_TWO) {
			ref.mat.x = float2(bin.read(file, f2dot14), bin.read(file, f2dot14));		// where the x axis goes: the first two numbers
			ref.mat.y = float2(bin.read(file, f2dot14), bin.read(file, f2dot14));
		}
		if (flags & COMPOUND.USE_MY_METRICS)
			ref.useMyMetrics = true;
		if (flags & COMPOUND.ROUND_TO_GRID)
			ref.roundToGrid = true;
		if (flags & COMPOUND.SCALED_OFFSET && !(flags & COMPOUND.UNSCALED_OFFSET))
			ref.scaledOffset = true;

		refs.push(ref);
		if (!(flags & COMPOUND.MORE_COMPONENTS))
			break;
	}
	return {refs, overlap, have_instructions: !!(all_flags & COMPOUND.HAVE_INSTRUCTIONS)};
}

// The outline Glyph.curve holds, from contours of points as a glyph stores them (each a run of {x, y, on}). A contour
// has to begin on a point on the curve, since that is where the outline starts and ends. TrueType lets a contour begin
// anywhere (a round glyph's often starts on a control point), so the points from the first on-curve one to the end are
// moved to the front. A contour with none at all is made of off-curve points only, and starts at the point the format
// implies halfway between its last and first. A point or a line is no outline, and is left out.
//@internal
export function contoursToCurve(contours: {x: number, y: number, on: boolean}[][]): curveVertex[] {
	const out: curveVertex[] = [];
	for (const points of contours) {
		if (points.length < 3)
			continue;
		const contour: curveVertex[] = points.map(p => curveVertex<number>(p.x, p.y, p.on ? ON_CURVE : OFF_BEZ2));
		let k = contour.findIndex(v => v.flags == ON_CURVE);
		if (k < 0) {
			const last = contour[contour.length - 1], first = contour[0];
			contour.unshift(curveVertex((last.x + first.x) / 2, (last.y + first.y) / 2, ON_CURVE));
			k = 0;
		}
		arrayRotate(contour, 0, contour.length, contour.length - k);		// rotate right by what follows the on-curve point
		contour[0].flags = ON_BEGIN;
		out.push(...contour);
	}
	return out;
}

// A glyph as glyf stores it, to read or to write. Read from a stream it is the Glyph that getGlyph gives. Made from a
// Glyph's parts (an outline or components, a bounding box and whether it overlaps) it gives the bytes for glyf with
// toBytes(). Hinting instructions are written only if they are given here: they are about the numbering of the points
// they were made for, which a glyph's outline in Glyph.curve does not keep.
//@internal
export class GlyphSerialiser extends bin.Class({
	num_contours:	s16,
	min:			vec2(s16),
	max:			vec2(s16),
}) implements Glyph {
	curve?:			curveVertex[];
	refs?:			GlyphRef[];
	instructions?:	Instructions;
	overlap?:		boolean;

	constructor(file: bin.stream);
	constructor(glyph: Partial<Pick<Glyph, 'curve' | 'refs' | 'min' | 'max' | 'overlap' | 'instructions'>>, options?: {tolerance?: number});
	constructor(file: bin.stream | Partial<Glyph>, options?: {tolerance?: number}) {
		if (file instanceof bin._stream) {
			super(file);
			this.decodeGlyph(file);
			return;
		}

		const round = (v: number) => {
			v = Math.round(v);
			if (v < -32768 || v > 32767)
				throw new RangeError(`coordinate ${v} does not fit a TrueType glyph`);
			return v;
		};

		if (file.refs?.length) {
			// the box has to be given, as what the components make is not known here
			if (!file.min || !file.max)
				throw new Error('a composite glyph needs its bounding box');
			super({num_contours: -1, min: float2(round(file.min.x), round(file.min.y)), max: float2(round(file.max.x), round(file.max.y))});
			this.refs = file.refs;
		} else {
			// cubics become quadratics; each coordinate is a whole number of font units
			const source = file.curve ?? [];
			const quadratic = source.every(v => v.flags <= OFF_BEZ2) ? source : bezier2Curve(source, options?.tolerance ?? 0.5);
			const curve = quadratic.map(v => curveVertex(round(v.x), round(v.y), v.flags));
			// the box of all its points, those off the curve too, as the format has it
			const xs = curve.map(v => v.x), ys = curve.map(v => v.y);
			super({
				num_contours:	curve.filter(v => v.flags === ON_BEGIN).length,
				min:			curve.length ? float2(Math.min(...xs), Math.min(...ys)) : float2(0, 0),
				max:			curve.length ? float2(Math.max(...xs), Math.max(...ys)) : float2(0, 0),
			});
			this.curve = curve;
		}
		this.overlap		= file.overlap || undefined;
		this.instructions	= file.instructions as Instructions | undefined;
	}

	// what the glyph has, for the tables that summarise the glyphs
	get points()		{ return this.curve?.length ?? 0; }
	get contours()		{ return Math.max(this.num_contours, 0); }
	get components()	{ return this.refs?.length ?? 0; }

	decodeGlyph(file: bin.stream) {
		if (this.num_contours < 0) {
			const {refs, have_instructions, overlap} = readComposite(file);
			this.refs = refs;
			this.overlap = overlap || undefined;
			if (have_instructions)
				this.instructions	= bin.read(file, bin.Buffer(u16)) as Instructions;

		} else {
			const end_pts		= bin.readn(file, u16, this.num_contours);
			this.instructions	= bin.read(file, bin.Buffer(u16)) as Instructions;
			const npts			= end_pts[this.num_contours - 1] + 1;

			const flags: number[] = [];
			for (let i = 0; i < npts; ++i) {
				const	f = bin.read(file, bin.UINT8);
				flags[i] = f;
				if (f & SIMPLE.REPEAT) {
					for (let n = bin.read(file, bin.UINT8); n--;)
						flags[++i] = f;
				}
			}
			
			function getDelta(SHORT: boolean, SAMEPOS: boolean) {
				return SHORT
					? bin.read(file, u8) * (SAMEPOS ? 1 : -1)
					: SAMEPOS ? 0 : bin.read(file, s16);
			}


			let		x	= 0;
			const points = flags.map(f => ({
				x:	x += getDelta(!!(f & SIMPLE.SHORT_X), !!(f & SIMPLE.SAME_X)),
				y:	0,
				on:	!!(f & SIMPLE.ON_CURVE),
			}));

			x = 0;
			flags.forEach((f, i) => {
				points[i].y		= x += getDelta(!!(f & SIMPLE.SHORT_Y), !!(f & SIMPLE.SAME_Y));
			});
			this.overlap	= !!(flags[0] & SIMPLE.OVERLAP) || undefined;

			const contours = end_pts.map((e, i) => points.slice(i ? end_pts[i - 1] + 1 : 0, e + 1));
			this.curve	= contoursToCurve(contours);
		}
	}

	write(file: bin.stream) {
		super.write(file);
		if (this.num_contours < 0)
			this.encodeComposite(file);
		else
			this.encodeGlyph(file);
		file.align(4);
	}

	// glyf's entry for the glyph, padded to a multiple of four bytes. A glyph with nothing to draw has no entry at all.
	toBytes() {
		if (!this.points && !this.components)
			return new Uint8Array(0);
		// (Class's own toBytes writes only the header's fields, not what write() adds)
		const stream = new bin.growingStream();
		this.write(stream);
		return stream.terminate();
	}

	// the points of a simple glyph: where each contour ends, the instructions, a flag for each point (a run of the same
	// flag stored once, with a count), then the x and the y coordinates, each as the change from the point before
	encodeGlyph(file: bin.stream) {
		const curve = this.curve ?? [];
		const end_pts = curve.flatMap((v, i) => v.flags === ON_BEGIN && i ? [i - 1] : []);
		end_pts.push(curve.length - 1);

		const flags: number[] = [], dxs: number[] = [], dys: number[] = [];
		let px = 0, py = 0;
		curve.forEach((v, i) => {
			const dx = v.x - px, dy = v.y - py;
			let f = v.flags === OFF_BEZ2 ? 0 : SIMPLE.ON_CURVE;
			// a change of zero is just said to be the same; one that fits a byte is a byte, with its sign in the flag
			f |= dx === 0 ? SIMPLE.SAME_X : Math.abs(dx) < 256 ? SIMPLE.SHORT_X | (dx > 0 ? SIMPLE.SAME_X : 0) : 0;
			f |= dy === 0 ? SIMPLE.SAME_Y : Math.abs(dy) < 256 ? SIMPLE.SHORT_Y | (dy > 0 ? SIMPLE.SAME_Y : 0) : 0;
			if (!i && this.overlap)
				f |= SIMPLE.OVERLAP;
			flags.push(f);
			dxs.push(dx);
			dys.push(dy);
			px = v.x;
			py = v.y;
		});

		bin.writen(file, u16, end_pts);
		bin.write(file, bin.Buffer(u16), this.instructions ?? new Uint8Array(0));
		for (let i = 0; i < flags.length;) {
			let n = 1;
			while (i + n < flags.length && flags[i + n] === flags[i] && n < 256)
				n++;
			if (n > 1) {
				bin.write(file, u8, flags[i] | SIMPLE.REPEAT);
				bin.write(file, u8, n - 1);
			} else {
				bin.write(file, u8, flags[i]);
			}
			i += n;
		}
		const axes: [number[], number, number][] = [[dxs, SIMPLE.SHORT_X, SIMPLE.SAME_X], [dys, SIMPLE.SHORT_Y, SIMPLE.SAME_Y]];
		for (const [deltas, SHORT, SAME] of axes)
			flags.forEach((f, i) => {
				if (f & SHORT)
					bin.write(file, u8, Math.abs(deltas[i]));
				else if (!(f & SAME))
					bin.write(file, s16, deltas[i]);
			});
	}

	// the components of a composite: each with the flags that say how what follows is stored. How its arguments are
	// sized and which form its scale takes are worked out here from the matrix, so that only what a matrix cannot say
	// (see GlyphRef) has to be given.
	encodeComposite(file: bin.stream) {
		const refs = this.refs!;
		refs.forEach((ref, i) => {
			const m = ref.mat;
			const args = ref.match ?? [Math.round(m.z.x), Math.round(m.z.y)];
			const words = ref.match ? args.some(a => a > 255) : args.some(a => a < -128 || a > 127);
			let flags = (ref.match ? 0 : COMPOUND.ARGS_XY) | (words ? COMPOUND.ARG12_WORDS : 0);
			if (i < refs.length - 1)
				flags |= COMPOUND.MORE_COMPONENTS;
			else if (this.instructions?.length)
				flags |= COMPOUND.HAVE_INSTRUCTIONS;
			if (ref.useMyMetrics)
				flags |= COMPOUND.USE_MY_METRICS;
			if (ref.roundToGrid)
				flags |= COMPOUND.ROUND_TO_GRID;
			if (ref.scaledOffset)
				flags |= COMPOUND.SCALED_OFFSET;
			if (this.overlap && !i)
				flags |= COMPOUND.OVERLAP;

			let scale: number[] = [];
			if (m.x.y === 0 && m.y.x === 0) {
				if (m.x.x !== 1 || m.y.y !== 1) {
					flags |= m.x.x === m.y.y ? COMPOUND.HAVE_SCALE : COMPOUND.X_AND_Y_SCALE;
					scale = m.x.x === m.y.y ? [m.x.x] : [m.x.x, m.y.y];
				}
			} else {
				flags |= COMPOUND.TWO_BY_TWO;
				scale = [m.x.x, m.x.y, m.y.x, m.y.y];
			}

			bin.write(file, u16, flags);
			bin.write(file, u16, ref.glyph);
			if (ref.match)
				bin.writen(file, words ? u16 : u8, args);
			else
				bin.writen(file, words ? s16 : s8, args);
			bin.writen(file, f2dot14, scale);
		});
		if (this.instructions?.length)
			bin.write(file, bin.Buffer(u16), this.instructions);
	}
}

//-----------------------------------------------------------------------------
//	sbix	Standard Bitmap Graphics Table	(TTF + OTF)
//-----------------------------------------------------------------------------

// a strike's glyphs: glyphDataOffsets[numGlyphs + 1], then the records they point at (from the strike's start), each
// as long as the gap to the next offset. The count is not stored: the first record follows the offsets directly.
const sbixGlyphs = {
	get: (s: bin.stream) => {
		const first		= s.read(u32);
		const offsets	= [first];
		for (let n = first / 4 - 2; n > 0; --n)
			offsets.push(s.read(u32));
		return offsets.slice(0, -1).map((off, i) => {
			const size = offsets[i + 1] - off - 8;
			return size < 0 ? {originOffset: float2(0, 0), type: '', data: new Uint8Array(0)}
				: s.offsetStream(off).read({originOffset: vec2(s16), type: TAG, data: bin.Buffer(size)}) as GlyphImage;
		});
	},
	put: () => { throw new Error('sbix is read only'); },
} as unknown as bin.TypeT<GlyphImage[]>;

const sbix = {
	version:	u16,	//1
	flags:		bin.as(u16, bin.EnumString( {DRAW_OUTLINES: 1 << 1})),
	strikes:	bin.Array(u32, bin.Offset(u32, {
		ppem:	u16,							//The PPEM size for which this strike was designed.
		ppi:	u16,							//The device pixel density (in PPI) for which this strike was designed. (E.g., 96 PPI, 192 PPI.)
		glyphs: sbixGlyphs,
	})),
};

//-----------------------------------------------------------------------------
//  EBLC & CBLC Extended Bitmap Location Table (TTF)
//-----------------------------------------------------------------------------

const SmallGlyphMetrics = {
	height: 		u8,	// Height of bitmap in pixels
	width: 			u8,	// Width of bitmap in pixels
	bearingX: 		s8,	// Left side bearing in pixels
	bearingY: 		s8,	// Top side bearing in pixels
	advance: 		u8,	// Advance width/height in pixels
};

const BigGlyphMetrics = {...SmallGlyphMetrics,
	vertBearingX: 	s8,	// Vertical left side bearing in pixels
	vertBearingY: 	s8,	// Vertical top side bearing in pixels
	vertAdvance: 	u8,	// Vertical advance in pixels
};

interface EBDTFormat {
	data:	Uint8Array;
	type?:	string;
	[K: string]: any;
}

const SbitBitmapFormat = {
	1: {  // small metrics, byte-aligned data
		metrics: SmallGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('byte'),
	},
	2: {  // small metrics, bit-aligned data
		metrics: SmallGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('bit '),
	},
	3: {  // (obsolete)
		metrics: BigGlyphMetrics,
		data: bin.Remainder,
	},
	4: {  // (obsolete)
		metrics: BigGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('zlib '),
	},
	5: {  // metrics in EBLC, bit-aligned image data only
		data: bin.Remainder,
		type: bin.Const('bit '),
	},
	6: {  // big metrics, byte-aligned data
		metrics: BigGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('byte'),
	},
	7: {  // big metrics, bit-aligned data
		metrics: BigGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('bit '),
	},
	8: {  // small metrics, component data
		metrics: SmallGlyphMetrics,
		type: bin.Const('comp'),
		components: bin.Array(u16, {
			glyphID: u16,
			xOffset: s8,
			yOffset: s8,
		}),
	},
	9: {  // big metrics, component data
		metrics: BigGlyphMetrics,
		type: bin.Const('comp'),
		components: bin.Array(u16, {
			glyphID: u16,
			xOffset: s8,
			yOffset: s8,
		}),
	},
	17: { // small metrics, PNG image data
		metrics: SmallGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('png '),
	},
	18: { // big metrics, PNG image data
		metrics: BigGlyphMetrics,
		data: bin.Remainder,
		type: bin.Const('png '),
	},
	19: { // metrics in EBLC, PNG image data only
		data: bin.Remainder,
		type: bin.Const('png '),
	},
};


abstract class EBLCLookup extends bin.Class({
	imageFormat: 		u16,
	imageDataOffset: 	u32,
}) {
	abstract getData(data: Uint8Array, id: number): { data: Uint8Array, metrics?: any};
}

const EBLC_SubTable = {
	firstGlyphIndex: 	u16,
	lastGlyphIndex: 	u16,
	sub: 	as<EBLCLookup>(bin.Offset(u32, bin.Switch(u16, {
		1: class extends bin.Extend(EBLCLookup, {
			offsets:			bin.Array(s => s.obj.obj.lastGlyphIndex - s.obj.obj.firstGlyphIndex + 2, u32)
		}) {
			getData(data: Uint8Array, id: number): any {
				return {data: data.subarray(this.offsets[id], this.offsets[id + 1])};
			}
		},
		2: class extends bin.Extend(EBLCLookup, {
			imageSize:			u32,
			metrics:			BigGlyphMetrics,
		}) {
			getData(data: Uint8Array, id: number): any {
				return {data: data.subarray(this.imageSize * id, this.imageSize * (id + 1)), metrics: this.metrics};
			}
		},
		3: class extends bin.Extend(EBLCLookup, {
			offsets:			bin.Array(s => s.obj.obj.lastGlyphIndex - s.obj.obj.firstGlyphIndex + 2, u16)
		}) {
			getData(data: Uint8Array, id: number): any {
				return {data: data.subarray(this.offsets[id], this.offsets[id + 1])};
			}
		},
		4: class extends bin.Extend(EBLCLookup, {
			glyphIds:			bin.Array(u32, {glyphID:	u16, sbitOffset: u16})
		}) {
			getData(data: Uint8Array, id: number): any {
				const i = this.glyphIds.find(i => i.glyphID === id);
				return {data: data.subarray( + (i?.sbitOffset ?? 0))};
			}
		},
		5: class extends bin.Extend(EBLCLookup, {
			imageSize:			u32,
			metrics: 			BigGlyphMetrics,
			glyphIds:			bin.Array(u32, u16),
		}) {
			getData(data: Uint8Array, id: number): any {
				const i = this.glyphIds.findIndex(i => i === id);
				return {data: data.subarray(this.imageSize * i, this.imageSize * (i + 1)), metrics: this.metrics};
			}
		},
	})))
};

const SbitLineMetrics = bin.Struct({
	ascender: 				s8,	// Distance in pixels from baseline to top of line
	descender: 				s8,	// Distance in pixels from baseline to bottom of line
	widthMax: 				u8,	// Width of widest bitmap in pixels
	caretSlopeNumerator: 	s8,	// Slope of caret in pixels
	caretSlopeDenominator: 	s8,	// Slope of caret in pixels
	caretOffset: 			s8,	// Offset of caret in pixels
	minOriginSB: 			s8,	// Minimum origin to left edge in pixels
	minAdvanceSB: 			s8,	// Minimum advance to right edge in pixels
	maxBeforeBL: 			s8,	// Maximum distance from origin to left edge in pixels
	minAfterBL: 			s8,	// Minimum distance from origin to right edge in pixels
	pad1: 					s8,	// Padding - set to 0
	pad2: 					s8,	// Padding - set to 0
});

class EBLCTable extends bin.Class({
	indexSubTableArrayOffset: 	bin.Offset(u32, bin.Remainder),// Offset to index subtable from beginning of EBLC
	indexTablesSize: 			u32,				// Number of bytes in corresponding index subtables and array
	numberOfIndexSubTables: 	u32,				// Number of index subtables
	colorRef: 					u32,				// Not used; set to 0
	hori: 						SbitLineMetrics,	// Line metrics for text rendered horizontally
	vert: 						SbitLineMetrics,	// Line metrics for text rendered vertically
	startGlyphIndex: 			u16,				// First glyph index in this size
	endGlyphIndex: 				u16,				// Last glyph index in this size
	ppemX: 						u8,					// Horizontal pixels per em
	ppemY: 						u8,					// Vertical pixels per em
	bitDepth: 					u8,					// The bit depth of this size (1, 2, 4, 8, 32)
	flags: 						u8,					// Vertical or horizontal metrics
}) {
	subs;
	constructor(s: bin._stream) {
		super(s);
		this.subs = bin.readn(new bin.stream(this.indexSubTableArrayOffset), EBLC_SubTable, this.numberOfIndexSubTables);
	}

	getGlyph(id: number, data: Uint8Array): GlyphImage | undefined {
		for (const i of this.subs) {
			if (id <= i.lastGlyphIndex) {
				const g		= i.sub.getData(data.subarray(i.sub.imageDataOffset), id - i.firstGlyphIndex);
				if (g.data.length) {
					const g1 = bin.read(new bin.stream(g.data), SbitBitmapFormat[i.sub.imageFormat as keyof typeof SbitBitmapFormat]) as EBDTFormat;
					if (g1) {
						const metrics = g1.metrics || g.metrics;
						return {
							type:			g1.type ?? this.bitDepth.toString(),
							originOffset:	float2(metrics.bearingX, metrics.bearingY),
							data:			g1.data
						};
					}
				}
			}
		}
	}
}

const EBLC = {
	version: u32,
	bitmapSizes: bin.Array(u32, EBLCTable),
};

const EBDT = {
	version: u32,					// Version number of the CBDT table (initially = 0x00020000)
	data: bin.Remainder,			// Bitmap data for various formats
};

//-----------------------------------------------------------------------------
//	SVG	(OTF)
//-----------------------------------------------------------------------------

const SVG = {
	version:	u16,//	Table version (starting at 0). Set to 0.
	documents:	bin.Offset(u32, bin.Array(u16, {
		startGlyphID:	u16,
		endGlyphID:		u16,
		doc:			bin.Offset(u32, bin.Remainder),
		doc_length: 	u32,
	
	})),
	reserved:	u32,//	Set to 0.
};

function getSVGTable(svg: bin.ReadType<typeof SVG>, id: number) {
	return svg.documents.find(d => id >= d.startGlyphID && id <= d.endGlyphID);
}
function getSVGTableIndex(svg: bin.ReadType<typeof SVG>, id: number) {
	return svg.documents.findIndex(d => id >= d.startGlyphID && id <= d.endGlyphID);
}


//-----------------------------------------------------------------------------
//	GSUB + GPOS + GDEF Common	(OTF)
//-----------------------------------------------------------------------------

class Coverage extends bin.Class({coverage: bin.Switch(u16, {
	1: {
		glyphs:	bin.Array(u16, u16),
	},
	
	2: {
		ranges:	bin.Array(u16, {
			start:				u16,	//First glyph ID in the range
			end:				u16,	//Last glyph ID in the range
			startCoverageIndex:	u16,	//Coverage Index of first glyph ID in range
		}),
	},
})}) {
	lookup(glyph: number) {
		if ('glyphs' in this.coverage) {
			return lowerBound(this.coverage.glyphs, i => i < glyph);
		} else {
			const	i = lowerBound(this.coverage.ranges, i => i.start < glyph);
			return i == this.coverage.ranges.length || this.coverage.ranges[i].end < glyph ? -1 : glyph - this.coverage.ranges[i].start + this.coverage.ranges[i].startCoverageIndex;
		}
	}
}

const LookupFlag = {
	RIGHT_TO_LEFT:				0x0001,	//This bit relates only to the correct processing of the cursive attachment lookup type (GPOS lookup type 3). When this bit is set, the last glyph in a given sequence to which the cursive attachment lookup is applied, will be positioned on the baseline.
	IGNORE_BASE_GLYPHS:			0x0002,	//If set, skips over base glyphs
	IGNORE_LIGATURES:			0x0004,	//If set, skips over ligatures
	IGNORE_MARKS:				0x0008,	//If set, skips over all combining marks
	USE_MARK_FILTERING_SET:		0x0010,	//If set, indicates that the lookup table structure is followed by a MarkFilteringSet field. The layout engine skips over all mark glyphs not in the mark filtering set indicated.
	reserved:					0x00E0,	//For future use (Set to zero)
	MARK_ATTACHMENT_TYPE_MASK:	0xFF00,	//If not zero, skips over all marks of attachment type different from specified.
} as const;
//type LookupFlag = typeof LookupFlag[keyof typeof LookupFlag];

/*
type AllValues<T> = T extends Record<number, Record<number, infer U>> ? U : never;

function LookupList0<T extends Record<number, Record<number, binary.Type>>>(tables: T) {
	type A = Record<number, AllValues<T>>;

	return binary.Array(u16, binary.Offset(u16, {
		type:	u16,
		flag:	asV(u16, LookupFlag),
		table:	binary.Switch(s => s.obj.type, Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, binary.Array(u16, binary.Offset(u16, binary.Switch(u16, v as A)))]))),
		//u16	markFilteringSet;	//Index (base 0) into GDEF mark glyph sets structure. This field is only present if the USE_MARK_FILTERING_SET lookup flag is set.
	}));
}
function LookupList2<S, T extends Record<number, Record<number, binary.TypeT<S>>> = Record<number, Record<number, binary.TypeT<S>>>>(tables: T) {
	return binary.Array(u16, binary.Offset(u16, {
		type:	u16,
		flag:	asV(u16, LookupFlag),
		table:	binary.Switch(s => s.obj.type, Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, binary.Array(u16, binary.Offset(u16, binary.Switch(u16, v)))]))),
		//u16	markFilteringSet;	//Index (base 0) into GDEF mark glyph sets structure. This field is only present if the USE_MARK_FILTERING_SET lookup flag is set.
	}));
}
*/


function LookupList<A>(tables: Record<number, Record<number, bin.Type>>) {
	return bin.Array(u16, bin.Offset(u16, {
		type:	u16,
		flag:	asV(u16, LookupFlag),
		table:	as<Record<number, A>>(bin.Switch(s => s.obj.type, Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, bin.Array(u16, bin.Offset(u16, bin.Switch(u16, v)))])))),
		//u16	markFilteringSet;	//Index (base 0) into GDEF mark glyph sets structure. This field is only present if the USE_MARK_FILTERING_SET lookup flag is set.
	}));
}

const FeatureList = bin.Array(u16, {
	tag:		TAG,
	feature:	bin.Offset(u16, {
		params:		bin.Offset(u16, bin.Remainder),
		indices:	bin.Array(u16, u16),
	}),
});

const LangSys = {
	lookupOrderOffset:		bin.Offset(u16, bin.Remainder),		//= NULL (reserved for an offset to a reordering table)
	requiredFeatureIndex:	u16,	//Index of a feature required for this language system; if no required features = 0xFFFF
	featureIndices:			bin.Array(u16, u16),
};

const Script = {
	defaultLangSys:		bin.Offset(u16, LangSys),
	langSysRecords:		bin.Array(u16, {
		tag:		TAG,
		langSys:	bin.Offset(u16, LangSys),
	}),
};

const ScriptList = bin.Array(u16, {
	tag:	TAG,
	script:	bin.Offset(u16, Script),
});

//-------------------------------------

const ClassDef = {
	format:	u16,
	data: bin.Switch(s => s.obj.format, {
		1: {
			start:	u16,		//First glyph ID of the classValueArray
			values:	bin.Array(u16, u16),
		},
		2: {
			ranges: bin.Array(u16, {
				start:	u16,	//First glyph ID in the range
				end:	u16,	//Last glyph ID in the range
				Class:	u16,	//Applied to all glyphs in the range
			}),
		},
	})
};

//-------------------------------------

const SequenceLookup = {
	sequenceIndex:		u16,	//Index (zero-based) into the input glyph sequence
	lookupListIndex:	u16,	//Index (zero-based) into the LookupList
};

const ClassSequenceRuleSet = bin.Array(u16, bin.Offset(u16, {
	glyphCount:			u16,	//Number of glyphs in the input glyph sequence
	seqLookupCount:		u16,	//Number of SequenceLookupRecords
	input:				bin.Array(s => s.obj.glyphCount - 1, u16),	//Array of input glyph IDs'starting with the second glyph
	seqLookup:			bin.Array(s => s.obj.seqLookupCount, SequenceLookup),
}));

const SequenceContext = {
	1: {
		coverage:	bin.Offset(u16, Coverage),
		rule_sets:	bin.Array(u16, bin.Offset(u16, ClassSequenceRuleSet)),
	},
	
	2: {
		coverage:	bin.Offset(u16, Coverage),						
		class_defs:	bin.Offset(u16, ClassDef),						
		rule_sets:	bin.Array(u16, bin.Offset(u16, ClassSequenceRuleSet)),
	},
	
	3: {
		glyphCount:	u16,
		seqLookupCount:	u16,
		coverages:	bin.Array(s => s.obj.glyphCount, bin.Offset(u16, Coverage)),
		seqLookup:	bin.Array(s => s.obj.seqLookupCount, SequenceLookup),
	}
};

//-------------------------------------

const ChainedSequenceRule = {
	_backtrack:	bin.Array(u16, u16),
	//u16	backtrackGlyphCount;	//Number of glyphs in the backtrack sequence
	//u16	backtrackSequence;//[backtrackGlyphCount];	//Array of backtrack glyph IDs
	//u16	inputGlyphCount;	//Number of glyphs in the input sequence
	//u16	inputSequence;//[inputGlyphCount - 1];	//Array of input glyph IDs'start with second glyph
	//u16	lookaheadGlyphCount;	//Number of glyphs in the lookahead sequence
	//u16	lookaheadSequence;//[lookaheadGlyphCount];	//Array of lookahead glyph IDs
	//u16	seqLookupCount;	//Number of SequenceLookupRecords
	//SequenceLookup	seqLookupRecords;//[seqLookupCount];	//Array of SequenceLookupReco

	//auto	backtrack()	const	{ return _backtrack.all(); }
	//auto	input()		const	{ return ((glyph_table*)backtrack().end())->all(); }
	//auto	lookahead()	const	{ return ((glyph_table*)input().end())->all(); }
	//auto	seqLookup()	const	{ return ((table(u16, SequenceLookup)*)lookahead().end())->all(); }
};

const ChainedSequenceRuleSet = bin.Array(u16, bin.Offset(u16, ChainedSequenceRule));

const ChainedSequenceContext = {
	1: {
		coverage:	bin.Offset(u16, bin.Remainder),
		rule_sets:	bin.Array(u16, bin.Offset(u16, ChainedSequenceRuleSet)),
	},

	2: {
		coverage:	bin.Offset(u16, Coverage),
		backtrack:	bin.Offset(u16, ClassDef),	//table containing backtrack sequence context, from beginning of ChainedSequenceContextFormat2 table
		input:		bin.Offset(u16, ClassDef),	//table containing input sequence context, from beginning of ChainedSequenceContextFormat2 table
		lookahead:	bin.Offset(u16, ClassDef),	//table containing lookahead sequence context, from beginning of ChainedSequenceContextFormat2 table
		rule_sets:	bin.Array(u16, bin.Offset(u16, ChainedSequenceRuleSet)),
	},

	3: {
		_backtrack:	bin.Array(u16, bin.Offset(u16, Coverage)),
		//u16		backtrackGlyphCount;	//Number of glyphs in the backtrack sequence
		//binary.Offset(u16, void),	backtrackCoverageOffsets;//[backtrackGlyphCount]	Array of offsets to coverage tables for the backtrack sequence
		//u16		inputGlyphCount;	//Number of glyphs in the input sequence
		//binary.Offset(u16, void),	inputCoverageOffsets;//[inputGlyphCount]	Array of offsets to coverage tables for the input sequence
		//u16		lookaheadGlyphCount;	//Number of glyphs in the lookahead sequence
		//binary.Offset(u16, void),	lookaheadCoverageOffsets;//[lookaheadGlyphCount]	Array of offsets to coverage tables for the lookahead sequence
		//u16		seqLookupCount;	//Number of SequenceLookupRecords
		//SequenceLookup	seqLookupRecords;//[seqLookupCount]	Array of SequenceLookupRecords

		//auto	backtrack()	const	{ return _backtrack.all(); }
		//auto	input()		const	{ return ((glyph_table*)backtrack().end())->all(); }
		//auto	lookahead()	const	{ return ((glyph_table*)input().end())->all(); }
		//auto	seqLookup()	const	{ return ((table(u16, SequenceLookup)*)lookahead().end())->all(); }
	},
};

//-----------------------------------------------------------------------------
//	GSUB	Glyph Substitution Table	(OTF)
//-----------------------------------------------------------------------------

interface Substitution {
	substitute(id: number): number;
}

const GSUB = {
	version:		u32,
	scripts:		bin.Offset(u16, ScriptList),	
	features:		bin.Offset(u16, FeatureList),
	lookups:		bin.Offset(u16, LookupList<Substitution>({
		1: {//SINGLE		= 1,	// Replace one glyph with one glyph
			1:{//SINGLE1
				coverage:	bin.Offset(u16, Coverage),
				delta:		s16,		//Add to original glyph ID to get substitute glyph ID
				substitute:	bin.Const((id: number) => id)
			},
			2:{//SINGLE2
				coverage:	bin.Offset(u16, Coverage),
				subs:		bin.Array(u16, u16),	//	Array of substitute glyph IDs ' ordered by Coverage index
				substitute:	bin.Const((id: number) => id)
			},
		},
		2: {//MULTIPLE		= 2,	// Replace one glyph with more than one glyph
			1:		{//MULTIPLE1
				coverage:	bin.Offset(u16, Coverage),
				sequences:	bin.Array(u16, bin.Offset(u16, bin.Array(u16,u16))),
				substitute:	bin.Const((id: number) => id)
			},
		},
		3: {//ALTERN		= 3,	// Replace one glyph with one of many glyphs
			1: {//ALTERNATE1
				coverage:	bin.Offset(u16, Coverage),
				alternates:	bin.Array(u16, bin.Offset(u16, bin.Array(u16, u16))),
				substitute:	bin.Const((id: number) => id)
			},
		},
		4: {//LIGATURE		= 4,	// Replace multiple glyphs with one glyph
			1: {//LIGATURE1
				//struct Ligature		: LigatureGlyph, table(u16, u16) {};
				coverage:	bin.Offset(u16, Coverage),
				sets:		bin.Array(u16, bin.Offset(u16, bin.Array(u16, bin.Offset(u16, {ligature: u16})))),
				substitute:	bin.Const((id: number) => id)
			},
		},
		5: //CONTEXTUAL	= 5,	// Replace one or more glyphs in context
			SequenceContext,
		6: //CHAINED		= 6,	// Replace one or more glyphs in chained context
			ChainedSequenceContext,
		//7: {//EXTENSION		= 7,	// Extension mechanism for other substitutions (i.e. this excludes the Extension type substitution itself)
		//},
		8: {//REVERSE		= 8,	// Applied in reverse order, replace single glyph in chaining context
			1: {//REVERSE1
				coverage:	bin.Offset(u16, Coverage),
				_backtrack: bin.Array(u16, bin.Offset(u16, bin.Remainder)),
				//u16	backtrackGlyphCount;	//Number of glyphs in the backtrack sequence.
				//binary.Offset(u16, void),	backtrackCoverageOffsets;//[backtrackGlyphCount]	Array of offsets to coverage tables in backtrack sequence, in glyph sequence order.
				//u16	lookaheadGlyphCount;	//Number of glyphs in lookahead sequence.
				//binary.Offset(u16, void),	lookaheadCoverageOffsets;//[lookaheadGlyphCount]	Array of offsets to coverage tables in lookahead sequence, in glyph sequence order.
				//u16	glyphCount;	//Number of glyph IDs in the substituteGlyphIDs array.
				//u16	substituteGlyphIDs[];//	Array of substitute glyph IDs ' ordered by Coverage index.
			
				//auto	backtrack()		const	{ return _backtrack.all(); }
				//auto	input()			const	{ return ((glyph_table*)backtrack().end())->all(); }
				//auto	lookahead()		const	{ return ((glyph_table*)input().end())->all(); }
				//auto	substitute()	const	{ return ((table(u16, u16)*)lookahead().end())->all(); }
				substitute:	bin.Const((id: number) => id)
			},
		},
	})),
	v1:	bin.Optional(s => s.obj.version >= 0x00010001 , {
		variations:	bin.Offset(u32, bin.Remainder),
	}),
};

//-----------------------------------------------------------------------------
//	GPOS	Glyph Positioning Table	(OTF)
//-----------------------------------------------------------------------------

const ValueFormat = {
	X_PLACEMENT:		0x0001,	//Includes horizontal adjustment for placement
	Y_PLACEMENT:		0x0002,	//Includes vertical adjustment for placement
	X_ADVANCE:			0x0004,	//Includes horizontal adjustment for advance
	Y_ADVANCE:			0x0008,	//Includes vertical adjustment for advance
	X_PLACEMENT_DEVICE:	0x0010,	//Includes Device table (non-variable font) / VariationIndex table (variable font) for horizontal placement
	Y_PLACEMENT_DEVICE:	0x0020,	//Includes Device table (non-variable font) / VariationIndex table (variable font) for vertical placement
	X_ADVANCE_DEVICE:	0x0040,	//Includes Device table (non-variable font) / VariationIndex table (variable font) for horizontal advance
	Y_ADVANCE_DEVICE:	0x0080,	//Includes Device table (non-variable font) / VariationIndex table (variable font) for vertical advance
	Reserved:			0xFF00,	//For future use (set to zero)
} as const;
type ValueFormat = typeof ValueFormat[keyof typeof ValueFormat];

function ValueRecord(format: ValueFormat) {
	return {
		xPlacement:	bin.Optional(format & ValueFormat.X_PLACEMENT,			s16),	//Horizontal adjustment for placement, in design units.
		yPlacement:	bin.Optional(format & ValueFormat.Y_PLACEMENT,			s16),	//Vertical adjustment for placement, in design units.
		xAdvance:	bin.Optional(format & ValueFormat.X_ADVANCE, 			s16),	//Horizontal adjustment for advance, in design units ' only used for horizontal layout.
		yAdvance:	bin.Optional(format & ValueFormat.Y_ADVANCE, 			s16),	//Vertical adjustment for advance, in design units ' only used for vertical layout.
		xPlaDevice:	bin.Optional(format & ValueFormat.X_PLACEMENT_DEVICE,	bin.Offset(u16, bin.Remainder)),
		yPlaDevice:	bin.Optional(format & ValueFormat.Y_PLACEMENT_DEVICE,	bin.Offset(u16, bin.Remainder)),
		xAdvDevice:	bin.Optional(format & ValueFormat.X_ADVANCE_DEVICE,		bin.Offset(u16, bin.Remainder)),
		yAdvDevice:	bin.Optional(format & ValueFormat.Y_ADVANCE_DEVICE,		bin.Offset(u16, bin.Remainder)),
	};
}
interface ValueRecord extends bin.ReadType<ReturnType<typeof ValueRecord>> {};

const Anchor = {
	format: u16,
	data: bin.Switch(s => s.obj.format, {
		1: {//Anchor1
			xCoordinate: 	s16,	//Horizontal value, in design units
			yCoordinate: 	s16,	//Vertical value, in design units
		},
		2: {//Anchor2
			xCoordinate: 	s16,	//Horizontal value, in design units
			yCoordinate: 	s16,	//Vertical value, in design units
			anchorPoint: 	u16,	//Index to glyph contour point
		},
		3: {//Anchor3
			xCoordinate:	s16,	//Horizontal value, in design units
			yCoordinate:	s16,	//Vertical value, in design units
			xDevice:		bin.Offset(u16, bin.Remainder),
			yDevice:		bin.Offset(u16, bin.Remainder),
		},
	})
};

const MarkRecord = {
	markClass:		u16,
	markAnchor:		bin.Offset(u16, Anchor),
};

interface Position {
}
const GPOS = {
	vsersion:		u32,
	scripts:		bin.Offset(u16, ScriptList),	
	features:		bin.Offset(u16, FeatureList),
	lookups:		bin.Offset(u16, LookupList<Position>({
		1: {//	SINGLE			Adjust position of a single glyph
			1:{//SINGLE1
				coverage:		bin.Offset(u16, Coverage),
				valueFormat:	u16,		
				//valueRecord:	as<ValueRecord>(bin.FuncType(s => ValueRecord(s.obj.valueFormat))),
				valueRecord:	bin.FuncType(s => ValueRecord(s.obj.valueFormat)),
			},
			2:{//SINGLE2
				coverage:		bin.Offset(u16, Coverage),
				valueFormat:	u16,		
				values:			bin.Array(u16, bin.FuncType(s => ValueRecord(s.obj.valueFormat))),
			},
		},
		2: {//	PAIR			Adjust position of a pair of glyphs
			1: {//PAIR1
				coverage:		bin.Offset(u16, Coverage),
				valueFormat1:	u16,			//Defines the types of data in valueRecord1 ' for the first glyph in the pair (may be zero).
				valueFormat2:	u16,			//Defines the types of data in valueRecord2 ' for the second glyph in the pair (may be zero).
				pairSets:		bin.Array(u16, bin.Offset(u16, bin.Array(u16, {
					secondGlyph:	u16,				//Glyph ID of second glyph in the pair (first glyph is listed in the Coverage table).
					valueRecord1:	bin.FuncType(obj => ValueRecord(obj.obj.valueFormat1)),		//Positioning data for the first glyph in the pair.
					valueRecord2:	bin.FuncType(obj => ValueRecord(obj.obj.valueFormat2)),		//Positioning data for the second glyph in the pair.
				}))),
			},
			2: {//PAIR2
				coverage:		bin.Offset(u16, Coverage),
				valueFormat1:	u16,	// for the first glyph of the pair (may be zero).
				valueFormat2:	u16,	// for the second glyph of the pair (may be zero).
				classDef1Offset:bin.Offset(u16, ClassDef),	//Offset to ClassDef table, from beginning of PairPos subtable ' for the first glyph of the pair.
				classDef2Offset:bin.Offset(u16, ClassDef),	//Offset to ClassDef table, from beginning of PairPos subtable ' for the second glyph of the pair.
				class1Count:	u16,	//Number of classes in classDef1 table ' includes Class 0.
				class2Count:	u16,	//Number of classes in classDef2 table ' includes Class 0.
				records:		bin.Array(s => s.obj.class1Count * s.obj.class2Count, {
					valueRecord1:	bin.FuncType(obj => ValueRecord(obj.obj.valueFormat1)),	//Positioning for first glyph ' empty if valueFormat1 = 0.
					valueRecord2:	bin.FuncType(obj => ValueRecord(obj.obj.valueFormat2)),	//Positioning for second glyph ' empty if valueFormat2 = 0.
				}),//	Array of Class1 records, ordered by classes in classDef1.
			},
		},
		3: {//	CURSIVE			Attach cursive glyphs
			1:{//CURSIVE1
				coverage:	bin.Offset(u16, Coverage),
				entryExits:	bin.Array(u16, {
					entryAnchor:	bin.Offset(u16, Anchor),
					exitAnchor:		bin.Offset(u16, Anchor),
				}),
			},
		},
		4: {//	MARK_TO_BASE	Attach a combining mark to a base glyph
			1:{//MARK_TO_BASE1
				markCoverage:	bin.Offset(u16, Coverage),
				baseCoverage:	bin.Offset(u16, Coverage),
				markClassCount:	u16,									//Number of classes defined for marks
				markArray:		bin.Offset(u16, bin.Array(u16, MarkRecord)),
				baseArray:		bin.Offset(u16, bin.Array(u16, bin.RemainingArray(bin.Offset(u16, Anchor)))),	//	Array of offsets (one per mark class) to Anchor tables. Offsets are from beginning of BaseArray table, ordered by class (offsets may be NULL).
			},
		},
		5: {//	MARK_TO_LIG		Attach a combining mark to a ligature
			1:{//MARK_TO_LIG1
				markCoverage:		bin.Offset(u16, Coverage),
				ligatureCoverage:	bin.Offset(u16, Coverage),
				markClassCount:		u16,								//Number of defined mark classes
				markArray:			bin.Offset(u16, bin.Array(u16, MarkRecord)),
				ligatureArray:		bin.Offset(u16, bin.Array(u16, bin.Offset(u16, bin.Array(u16, bin.Offset(u16, Anchor))))),
			},
		},
		6: {//	MARK_TO_MARK	Attach a combining mark to another mark
			1:{//MARK_TO_MARK1
				mark1Coverage:	bin.Offset(u16, Coverage),
				mark2Coverage:	bin.Offset(u16, Coverage),
				markClassCount:	u16,							//Number of Combining Mark classes defined
				mark1Array:		bin.Offset(u16, bin.Array(u16, MarkRecord)),
				mark2Array:		bin.Offset(u16, bin.Array(u16, bin.Offset(u16, Anchor))),
			},
		},
		7: //	CONTEXTUAL		Position one or more glyphs in context
			SequenceContext,
		8: //	CHAINED			positioning	Position one or more glyphs in chained context
			ChainedSequenceContext,
		9: {//	EXTENSION		Extension mechanism for other positionings
			1:{//EXTENSION1
				type:	u16,
				extension:		bin.Offset(u32, bin.Remainder),
			},
		},
	})),
	variations:		bin.Optional(s => s.obj.version >= 0x00010001,
		bin.Offset(u32, bin.Remainder)
	),
};

//-----------------------------------------------------------------------------
//  BASE  Baseline Table (OTF)
//-----------------------------------------------------------------------------

class BaseCoord extends bin.Class({
	format: u16,
	data: bin.Switch(s => s.obj.format, {
		1: {
			coordinate: 	s16,	// X or Y value, in design units
		},
		2: {
			coordinate: 	s16,	// X or Y value, in design units
			referenceGlyph: u16,	// Glyph ID of control glyph
			baseCoordPoint: u16,	// Index of contour point on the reference glyph
		},
		3: {
			coordinate: 	s16,	// X or Y value, in design units
			deviceTable:	bin.Offset(u16, bin.Remainder),
		}
	})
}) {}

const MinMax = {
	minCoord: bin.Offset(u16, BaseCoord, true),
	maxCoord: bin.Offset(u16, BaseCoord, true),
	featMinMaxRecords: bin.Array(u16, {
		tag: TAG,
		minCoord: bin.Offset(u16, BaseCoord, true),
		maxCoord: bin.Offset(u16, BaseCoord, true),
	}),
};

const BaseScript = {
	baseValues: bin.Offset(u16, {
		defaultIndex:	u16,		// Index of default baseline for this script
		baseCoords:		bin.Array(u16, bin.Offset(u16, BaseCoord)),
	}, true),
	defaultMinMax:		bin.Offset(u16, MinMax, true),
	baseLangSysRecords: bin.Array(u16, {
		tag:	TAG,
		minMax:	bin.Offset(u16, MinMax),
	}),
};

class Axis extends bin.Class({
	baseTagList: bin.Offset(u16, bin.Array(u16, TAG), true),
	baseScriptList: bin.Offset(u16, bin.Array(u16, {
		tag:	TAG,
		script:	bin.Offset(u16, BaseScript),
	})),
}) {}

const BASE = {
	version:	u32,		// Version of the BASE table (1.0), 0x00010000
	horizAxis:	bin.Offset(u16, Axis, true),
	vertAxis:	bin.Offset(u16, Axis, true),
	//v1_1:		binary.Optional(s => s.obj.version >= 0x00010001, {
	//		variations: binary.Offset(u32, u32, true),
	//})
};


//-----------------------------------------------------------------------------
//  MATH  Mathematical Typesetting Table (OTF)
//-----------------------------------------------------------------------------

class MathValueRecord extends bin.Class({
	value: s16,	// The X or Y value in design units
	deviceTable: bin.Offset(u16, bin.Remainder, true),  // Offset to device table
}) {};

const MathGlyphConstruction = {
	variants:	bin.Array(u16, {
		variantGlyph: 		u16,	// Glyph ID of the variant
		advanceMeasurement:	u16,	// Advance width/height, in design units
	}),
	assembly:	bin.Offset(u16, {
		italicsCorrection:		MathValueRecord,		// Italics correction of this assembly
		partRecords: bin.Array(u16, {
			glyphID:				u16,	// Glyph ID for the part
			startConnectorLength:	u16,	// Length of connector on left/top end
			endConnectorLength:		u16,	// Length of connector on right/bottom end
			fullAdvance:			u16,	// Total advance for this part
			partFlags:				u16,	// Part flags (0x0001 = extender part)
		}),
	}, true),
};

const MATH = {
	version:		u32,			// Version of the MATH table (1.0), 0x00010000
	constants:	bin.Offset(u16, {
		scriptPercentScaleDown: 					s16,				// Percentage scale down for level 1 superscripts and subscripts
		scriptScriptPercentScaleDown: 				s16,					// Percentage scale down for level 2 (scriptScript) superscripts and subscripts
		delimitedSubFormulaMinHeight: 				u16,					// Minimum height at which to treat a delimited expression as a subformula
		displayOperatorMinHeight: 					u16,					// Minimum height of n-ary operators (such as integral and summation)
		mathLeading: 								MathValueRecord,		// White space to be left between math formulas
		axisHeight: 								MathValueRecord,	// Axis height of the font
		accentBaseHeight: 							MathValueRecord,	// Maximum height of accent base that does not require raising the accents
		flattenedAccentBaseHeight: 					MathValueRecord,	// Maximum height of accent base that does not require flattening the accents
		subscriptShiftDown: 						MathValueRecord,	// Subscript shift down
		subscriptTopMax: 							MathValueRecord,	// Maximum height of subscript that does not require moving subscript down
		subscriptBaselineDropMin: 					MathValueRecord,	// Minimum subscript baseline drop
		superscriptShiftUp: 						MathValueRecord,	// Superscript shift up
		superscriptShiftUpCramped: 					MathValueRecord,	// Superscript shift up in cramped style
		superscriptBottomMin: 						MathValueRecord,	// Minimum superscript bottom in loose style
		superscriptBaselineDropMax: 				MathValueRecord,	// Maximum superscript baseline drop
		subSuperscriptGapMin: 						MathValueRecord,	// Minimum gap between subscript and superscript
		superscriptBottomMaxWithSubscript: 			MathValueRecord,	// Maximum superscript bottom when subscript is present
		spaceAfterScript: 							MathValueRecord,	// Extra white space after scripts
		upperLimitGapMin: 							MathValueRecord,	// Minimum gap between base and upper limit
		upperLimitBaselineRiseMin: 					MathValueRecord,	// Minimum rise of baseline for upper limit
		lowerLimitGapMin: 							MathValueRecord,	// Minimum gap between base and lower limit
		lowerLimitBaselineDropMin: 					MathValueRecord,	// Minimum drop of baseline for lower limit
		stackTopShiftUp: 							MathValueRecord,	// Shift up of baseline for numerator
		stackTopDisplayStyleShiftUp: 				MathValueRecord,	// Shift up of baseline for numerator in display style
		stackBottomShiftDown: 						MathValueRecord,	// Shift down of baseline for denominator
		stackBottomDisplayStyleShiftDown: 			MathValueRecord,	// Shift down of baseline for denominator in display style
		stackGapMin: 								MathValueRecord,	// Minimum gap between numerator and denominator
		stackDisplayStyleGapMin: 					MathValueRecord,	// Minimum gap between numerator and denominator in display style
		stretchStackTopShiftUp: 					MathValueRecord,	// Shift up of baseline for numerator in stretched stack
		stretchStackBottomShiftDown: 				MathValueRecord,	// Shift down of baseline for denominator in stretched stack
		stretchStackGapAboveMin: 					MathValueRecord,	// Minimum gap between numerator and extenders
		stretchStackGapBelowMin: 					MathValueRecord,	// Minimum gap between denominator and extenders
		fractionNumeratorShiftUp: 					MathValueRecord,	// Shift up of numerator in fraction
		fractionNumeratorDisplayStyleShiftUp: 		MathValueRecord,	// Shift up of numerator in display style fraction
		fractionDenominatorShiftDown: 				MathValueRecord,	// Shift down of denominator in fraction
		fractionDenominatorDisplayStyleShiftDown: 	MathValueRecord,	// Shift down of denominator in display style fraction
		fractionNumeratorGapMin: 					MathValueRecord,	// Minimum gap between numerator and rule
		fractionNumDisplayStyleGapMin: 				MathValueRecord,	// Minimum gap between numerator and rule in display style
		fractionRuleThickness: 						MathValueRecord,	// Thickness of fraction rule
		fractionDenominatorGapMin: 					MathValueRecord,	// Minimum gap between denominator and rule
		fractionDenomDisplayStyleGapMin: 			MathValueRecord,	// Minimum gap between denominator and rule in display style
		skewedFractionHorizontalGap: 				MathValueRecord,	// Horizontal gap between parts of skewed fraction
		skewedFractionVerticalGap: 					MathValueRecord,	// Vertical gap between parts of skewed fraction
		overbarVerticalGap: 						MathValueRecord,	// Gap between base and overbar
		overbarRuleThickness: 						MathValueRecord,	// Thickness of overbar
		overbarExtraAscender: 						MathValueRecord,	// Extra white space reserved above overbar
		underbarVerticalGap: 						MathValueRecord,	// Gap between base and underbar
		underbarRuleThickness: 						MathValueRecord,	// Thickness of underbar
		underbarExtraDescender: 					MathValueRecord,	// Extra white space reserved below underbar
		radicalVerticalGap: 						MathValueRecord,	// Space between rule and radical
		radicalDisplayStyleVerticalGap: 			MathValueRecord,	// Space between rule and radical in display style
		radicalRuleThickness: 						MathValueRecord,	// Thickness of radical rule
		radicalExtraAscender: 						MathValueRecord,	// Extra white space reserved above radical
		radicalKernBeforeDegree: 					MathValueRecord,	// Extra space before degree of radical
		radicalKernAfterDegree: 					MathValueRecord,	// Negative kern after degree of radical
		radicalDegreeBottomRaisePercent: 			s16,				// Height of degree as percentage of rule thickness
	}),
	glyphInfo:	bin.Offset(u16, {
		mathItalicsCorrectionInfo:	bin.Offset(u16, {
			coverage:				bin.Offset(u16, Coverage),
			italicsCorrection:		bin.Array(u16, MathValueRecord),
		}),
		mathTopAccentAttachment:	bin.Offset(u16, {
			coverage:				bin.Offset(u16, Coverage),
			topAccentAttachment:	bin.Array(u16, MathValueRecord),
		}),
		extendedShapeCoverage:		bin.Offset(u16, Coverage),
		mathKernInfo:				bin.Offset(u16, {
			coverage: bin.Offset(u16, Coverage),
			kernInfo: bin.Array(u16, {
				topRightMathKern:		bin.Offset(u16, bin.Array(u16, MathValueRecord), true),
				topLeftMathKern:		bin.Offset(u16, bin.Array(u16, MathValueRecord), true),
				bottomRightMathKern:	bin.Offset(u16, bin.Array(u16, MathValueRecord), true),
				bottomLeftMathKern:		bin.Offset(u16, bin.Array(u16, MathValueRecord), true),
			}),
		}),
	}),
	variants:	bin.Offset(u16, {
		minConnectorOverlap:	u16,   // Minimum overlap of connecting glyphs
		vertGlyphCount:			u16,		// Number of glyphs with vertical variants
		horizGlyphCount:		u16,		// Number of glyphs with horizontal variants
		vertGlyphCoverage:		bin.Offset(u16, Coverage),
		horizGlyphCoverage:		bin.Offset(u16, Coverage),
		vertGlyphConstructions:	bin.Array(s => s.obj.vertGlyphCount, bin.Offset(u16, MathGlyphConstruction)),
		horizGlyphConstructions: bin.Array(s => s.obj.horizGlyphCount, bin.Offset(u16, MathGlyphConstruction)),
	}),
};


//-----------------------------------------------------------------------------
//	DSIG	(mostly OTF)
//-----------------------------------------------------------------------------

const DSIG = {
	version:			u32,				// Version number of the DSIG table (0x00000001)
	numSignatures:		u16,				// Number of signatures in the table
	flags:				u16,				// Permission flags:bit 0: cannot be resigned,bits 1-7: Reserved (Set to 0)
	signatureRecords:	bin.Array(s => s.obj.numSignatures, {
		format:	u32,
		length:	u32,
		block:	bin.Offset(u32, bin.Switch(s => s.obj.format, {
			1:	{
				reserved1:	u16,				// Reserved for future use; set to zero.
				reserved2:	u16,				// Reserved for future use; set to zero.
				signature:	bin.Buffer(u32),	// PKCS#7 packetBlock1
			}
		})),
	}),
};

//-----------------------------------------------------------------------------
//	Font
//-----------------------------------------------------------------------------


export function getElementById(e: xml.Element, id: string): xml.Element|undefined {
	if (e.attributes.id === id)
		return e;

	for (const i of e.allElements()) {
		const x = getElementById(i, id);
		if (x)
			return x;
	}
}

const tableReaders = {
	'OS/2':	OS2,
	head:	head,
	hhea:	MetricsHead,
	vhea:	MetricsHead,
	maxp:	maxp,
	name:	name,
	cmap:	cmap,
	gasp:	gasp,
	sbix:	sbix,
	EBLC:	EBLC,
	CBLC:	EBLC,
	EBDT:	EBDT,
	CBDT:	EBDT,
	GSUB:	GSUB,
	GPOS:	GPOS,
	CPAL:	CPAL,
	COLR:	COLR,
	'SVG ':	SVG,
	'CFF ':	CFF,
	DSIG:	DSIG,
	BASE:	BASE,
	MATH:	MATH,

//	GDEF:	GDEF,
//	bgcl:	bgcl,
//	feat:	feat,
//	meta:	meta,
//	morx:	morx,
//	post:	post,
//	trak:	trak,
};

//@internal
export const tableTypes = Object.keys(tableReaders);

// a table is decoded the first time it is read, and from then on is that value. It stays configurable so that
// loadTable() can replace the table with a re-read of new bytes.
function fix<T>(obj: any, name: string, value: T): T {
	Object.defineProperty(obj, name, {value, writable: false, configurable: true, enumerable: true});
	return value;
}

// where a component puts its glyph: the matrix, with the offset scaled by it where the component says so. (A component
// placed by matching points is put at the origin, as what its point numbers name is not kept by the outlines.)
function placement(ref: GlyphRef) {
	const m = ref.mat;
	return ref.scaledOffset
		? float2x3(m.x, m.y, float2(m.x.x * m.z.x + m.y.x * m.z.y, m.x.y * m.z.x + m.y.y * m.z.y))
		: m;
}

const PNGSpec = {
	sig: bin.Expect(bin.String(8, 'latin1'), "\x89PNG\r\n\x1A\n"),
	_: bin.Merge(bin.RemainingRepeat({
		length: u32,
		type:   bin.String(4),
		_: bin.Merge(bin.Size('length', bin.Switch(s => s.lookupObj('type'), {
			IHDR:    { IHDR: { width: u32, height: u32, bitDepth: u8 } },
			PLTE:    { PLTE: bin.Array(s => s.lookupObj('length') / 3, { r: u8, g: u8, b: u8 }) },
			IDAT:    { IDAT: bin.Array(1, bin.Remainder) },
			default: {},
		}))),
	}))
};
type PNGSpec = bin.ReadType<typeof PNGSpec>;

export class Font extends makeClass<{
	[K in keyof typeof tableReaders]?: bin.ReadType<typeof tableReaders[K]>
}>() {
	hmtx?:		Metrics;
	vmtx?:		Metrics;
	glyphdata?: Uint8Array[];
	cached:		(Glyph|undefined)[] = [];

	family(): string | undefined { return this.name?.get(ID.PREF_FAMILY) ?? this.name?.get(ID.FAMILY); }
	subfamily(): string { return this.name?.get(ID.PREF_SUBFAMILY) ?? this.name?.get(ID.SUBFAMILY) ?? 'Regular'; }

	// Every table of the file as it was read -- those with no reader here too -- so that a font can be written out
	// again without losing what is not understood. Tables are decoded lazily from these bytes, which are never
	// changed in place: an edit goes through a method that says which table it changes (see `modified`).
	rawTables	= new Map<string, Uint8Array>();
	sfntVersion	= 0x00010000;					// 0x00010000, or 'OTTO' for a font with CFF outlines
	// the tables that are to be written from the font's data rather than copied from rawTables
	modified	= new Set<string>();
	// what has been done to each edited glyph, for the maxima the tables that summarise the glyphs must cover
	edits		= new Map<number, {min: {x: number, y: number}, max: {x: number, y: number}, points: number, contours: number, components?: number}>();

	// A table's reader applied to bytes that need not be the font's own, and its writer.
	decodeTable<K extends keyof typeof tableReaders>(tag: K, data: Uint8Array): bin.ReadType<typeof tableReaders[K]> {
		return bin.read(new bin.stream(data), tableReaders[tag]);
	}
	encodeTable(tag: keyof typeof tableReaders, value: object): Uint8Array {
		const s = new bin.growingStream();
		s.write(tableReaders[tag] as any, value);
		return s.terminate();
	}

	loadTable(tag: string, data: Uint8Array) {
		this.rawTables.set(tag, data);
		if (tag in tableReaders) {
			Object.defineProperty(this, tag, {
				get() { return fix(this, tag, this.decodeTable(tag as keyof typeof tableReaders, data)); },
				enumerable: true,
				configurable: true,
			});
		}
	}

	numGlyphs() {
		return this.maxp?.numGlyphs ?? this.glyphdata?.length ?? this.COLR?.v1?.baseGlyphs.length ?? this.cached.length ?? 0;
	}

	getGlyph(id: number): Glyph | undefined {
		let glyph = this.cached[id];
		if (!glyph) {
			const cff = this['CFF '];
			const data = this.glyphdata?.[id];
			// a space (or any other glyph with no ink) has a zero-length entry in glyf, by design -- not something
			// to read a GlyphReader header from, which needs at least a couple of bytes to be there at all
			glyph = cff				? cff.getGlyph(id)
				: data?.length		? new GlyphSerialiser(new bin.stream(data))
				: data				? {min: float2(0, 0), max: float2(0, 0)}
				: undefined;
			if (glyph)
				this.cached[id] = glyph;
		}
		return glyph;
	}

	getGlyphCurves(id: number, depth = 0): curveVertex[] {
		const glyph = this.getGlyph(id);
		if (!glyph)
			return [];
		if (!glyph.refs)
			return glyph.curve ?? [];

		// a component can itself be a composite; a loop of them is a malformed font
		const out = [...glyph.curve ?? []];
		if (depth < 8)
			for (const ref of glyph.refs)
				out.push(...transformCurve(this.getGlyphCurves(ref.glyph, depth + 1), placement(ref)));
		return out;

	}

	getGlyphMapping() {
		if (this.cmap) {
			//let uvs_table;
	
			//score the tables to favour UNICODE_FULL
			const	i = argmin(this.cmap.tables, i => {
				switch (i.platform) {
					case PLATFORM.UNICODE:
						//if (i.encoding == ENCODING.UNI_variation)
						//	uvs_table = i;
						return  Math.abs(i.encoding - ENCODING.UNI_full);
					case PLATFORM.WINDOWS:
						return i.encoding == ENCODING.WIN_UCS4 ? 1 : i.encoding == ENCODING.WIN_UCS2 ? 2 : 3;
					default:
						return 4;
				}
			});
			
			return this.cmap.tables[i].data.map();
		}
	}

	getGlyphImage(id: number, ppem: number): GlyphImage | undefined {
		if (this.sbix) {
			const i 	=  argmin(this.sbix.strikes, i => Math.abs(i.ppem - ppem));
			const images = this.sbix.strikes[i].glyphs;
			if (images[id].type === 'dupe')
				id = (images[id].data[0] << 8) + images[id].data[1];
			return images[id];

		} else if (this.CBLC && this.CBDT) {
			const i 	=  argmin(this.CBLC.bitmapSizes, i => Math.abs(i.ppemX - ppem));
			return this.CBLC.bitmapSizes[i].getGlyph(i, this.CBDT.data);
		}
	}
	getGlyphCOLR(id: number) {
		return this.COLR && this.COLR.getGlyph(this, this.CPAL, id);
	}

	
	getGlyphSVG(id: number, convert = 15) {
		const layers	= () => { const l = this.getGlyphCOLR(id); return l && SVGlayers(l); };
		const table		= () => {
			const svgs	= this['SVG '];
			const doc	= svgs && getSVGTable(svgs, id);
			return doc && !(doc.doc[0] === 0x1f && doc.doc[1] === 0x8b) && extractGlyphElement(bin.text.decode(doc.doc.subarray(0, doc.doc_length)), id);
		};
		const outline	= () => {
			const glyph = this.getGlyph(id);
			return glyph?.curve?.length && makeSVG(
				[new xml.Element('path', {d: makeSVGPath(parseCurve(glyph.curve!)), fill: 'currentColor'})],
				new float2.extent(float2(glyph.min.x, - glyph.max.y), float2(glyph.max.x, -glyph.min.x))
			);
		};
		// a PNG's size is in its header: width and height, big-endian, after the signature and chunk name
		const image		= () => {
			const ppem	= Math.max(0, ...(this.sbix?.strikes.map(s => s.ppem) ?? this.CBLC?.bitmapSizes.map(s => s.ppemX) ?? this.EBLC?.bitmapSizes.map(s => s.ppemX) ?? []));
			const img	= ppem && this.getGlyphImage(id, ppem);
			if (!img || !img.type.startsWith('png') || img.data.length < 24)
				return;
			const k		= (this.head?.units_per_em || 1000) / ppem;

			const png	= new bin.stream(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)).read(PNGSpec);
			const w		= (png.IHDR?.width ?? 0) * k, h = (png.IHDR?.height ?? 0) * k;
			const x		= img.originOffset.x * k, y = -(img.originOffset.y * k + h);
			const href	= 'data:image/png;base64,' + btoa(Array.from(img.data, b => String.fromCharCode(b)).join(''));
			return makeSVG([new xml.Element('image', {href, x, y, width: w, height: h})], new float2.extent(float2(x, y), float2(x + w, y + h)));
		};
		const svg = ((convert & 1) && layers()) || table() || ((convert & 2) && outline()) || ((convert & 4) && image());
		return svg || undefined;
	}

	//-----------------------------------------------------------------------------
	// modifications
	//-----------------------------------------------------------------------------

	// Makes a font with CFF outlines one with TrueType outlines, which is what can be edited and written: each glyph's cubics become quadratics (within half a font unit),
	// and the font is written as TrueType from then on. Hinting is lost. Returns false if there was nothing to convert.
	convertToTrueType(): boolean {
		if (this.glyphdata || !this['CFF '])
			return false;
		const n			= this.numGlyphs();
		const curves	= Array.from({length: n}, (_, id) => this.getGlyphCurves(id));
		this.glyphdata = Array.from({length: n}, () => new Uint8Array(0));
		delete (this as any)['CFF '];
		delete (this as any)['CFF2'];
		this.rawTables.delete('CFF ');
		this.rawTables.delete('CFF2');
		this.rawTables.delete('VORG');
		this.sfntVersion = 0x00010000;

		const m1 = {
			version:				0x00010000,
			numGlyphs:				n,
			maxPoints:				0,
			maxContours:			0,
			maxComponentPoints:		0,
			maxComponentContours:	0,
			maxZones:				1,
			maxTwilightPoints:		0,
			maxStorage:				0,
			maxFunctionDefs:		0,
			maxInstructionDefs:		0,
			maxStackElements:		0,
			maxSizeOfInstructions:	0,
			maxComponentElements:	0,
			maxComponentDepth:		0,
		};
		const s = new bin.growingStream();
		s.write(maxp, m1);
		this.loadTable('maxp', s.terminate());

		for (let id = 0; id < n; id++)
			this.setGlyph(id, {curve: curves[id]});
		return true;
	}


	// the font as a file: every table as it was read except those that have been changed
	save(): Uint8Array | Promise<Uint8Array> {
		return new Uint8Array(0);
	}

	setAdvance(id: number, advance: number) {
		const h = this.hmtx;
		if (!h)
			throw new Error('the font has no horizontal metrics');
		if (!Number.isInteger(advance) || advance < 0 || advance > 65535)
			throw new RangeError(`advance ${advance} does not fit`);
		// a glyph past the long metrics shares the last advance, so it has none of its own to change
		if (id >= h.metrics.length)
			throw new Error(`glyph ${id} has no advance of its own: it takes the last one in hmtx`);
		h.metrics[id].advance = advance;
		this.modified.add('hmtx');
	}

		// Replaces a glyph with `glyph`, as getGlyph gives one (so a glyph from getGlyph can be changed and put back): its
	// outline from `curve`, or if it has `refs` a composite of them, with the bounding box it was given or else that of
	// what they make. Its hinting instructions are dropped. The glyph's left side bearing follows its new extent; its
	// advance is left alone (see setAdvance). Only the glyphs of a font with TrueType outlines can be written.
	setGlyph(id: number, glyph: Partial<Pick<Glyph, 'curve' | 'refs' | 'min' | 'max' | 'overlap'>>) {
		const glyphs = this.glyphdata;
		if (!glyphs)
			throw new Error('only a font with TrueType outlines (glyf) can have its glyphs written');
		if (!Number.isInteger(id) || id < 0 || id >= glyphs.length)
			throw new RangeError(`no glyph ${id}`);

		const h = this.hmtx;

		interface Snapshot {
			data:		Uint8Array;
			bearing?:	number;
			edit?:		{min: {x: number, y: number}, max: {x: number, y: number}, points: number, contours: number, components?: number};
		}

		// the box the glyph had, which is in the first bytes of what is stored
		const before: Snapshot	= {
			data:		glyphs[id],
			edit:		this.edits.get(id),
			bearing:	h ? (id < h.metrics.length ? h.metrics[id].bearing : h.bearing[id - h.metrics.length]) : undefined
		};
		
		let {min, max} = glyph;
		if (glyph.refs?.length && (!min || !max)) {
			const all = glyph.refs.flatMap(ref => transformCurve(this.getGlyphCurves(ref.glyph), placement(ref)));
			min = all.length ? float2(Math.min(...all.map(v => v.x)), Math.min(...all.map(v => v.y))) : float2(0, 0);
			max = all.length ? float2(Math.max(...all.map(v => v.x)), Math.max(...all.map(v => v.y))) : float2(0, 0);
		}
		const encoded = new GlyphSerialiser({curve: glyph.curve, refs: glyph.refs, min, max, overlap: glyph.overlap});

		// the left side bearing keeps following the glyph's left edge if it did, as the convention has it (head.flags bit 1),
		// and is otherwise something the font chose, which is not changed
		const follows = !before.data || before.data.length < 10 || before.bearing === new DataView(before.data.buffer, before.data.byteOffset).getInt16(2);
		const after: Snapshot	= {
			data:		encoded.toBytes(),
			edit:		{min: encoded.min, max: encoded.max, points: encoded.points, contours: encoded.contours, components: encoded.components},
			bearing:	before.bearing !== undefined && follows && (encoded.points || encoded.components) ? encoded.min.x : undefined
		};

		const set = (snap: Snapshot) => {
			glyphs[id] = snap.data;
			this.cached[id] = undefined;
			if (snap.edit)
				this.edits.set(id, snap.edit);
			else
				this.edits.delete(id);
			if (h && snap.bearing !== undefined) {
				if (id < h.metrics.length)
					h.metrics[id].bearing = snap.bearing;
				else
					h.bearing[id - h.metrics.length] = snap.bearing;
				this.modified.add('hmtx');
			}
			this.modified.add('glyf');
		};
		set(after);
		return {undo: () => set(before), redo: () => set(after) };
	}

	// an edited document of a glyph put back into the document of the SVG table that it came from
	setGlyphSVG(id: number, edited: string) {
		const svg = this['SVG '];
		const index	= svg ? getSVGTableIndex(svg, id) : -1;
		if (index < 0)
			throw new Error(`the SVG table has no document for glyph ${id}`);

		// puts a document of the SVG table back as text (UTF-8), and writes the table again with everything else in it as it was
		const set = (text: string) => {
			const s		= new bin.growingStream();
			s.write(SVG, {
				version: 0,
				documents: svg!.documents.map((d, i) => {
					return {...d, doc: i === index ? bin.text.encode(text, 'utf8') : d.doc.subarray(0, d.doc_length), doc_length: 0};
				}),
				reserved: 0
			});
			this.loadTable('SVG ', s.terminate());
		};

		const doc		= svg!.documents[index];
		const before	= bin.text.decode(doc.doc.subarray(0, doc.doc_length));
		const after 	= mergeGlyphSVG(before, id, edited);
		set(after);

		return {
			undo: () => set(before),
			redo: () => set(after)
		};

	}


}
