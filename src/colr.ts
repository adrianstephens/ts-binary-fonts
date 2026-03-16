import * as binary from '@isopodlabs/binary';
import { Font, vec2 } from './font';
import { float2, float2x2, float2x3 } from '@isopodlabs/maths/vector';
import { circle } from '@isopodlabs/maths/geometry';

import {color, curveVertex, transformCurve, reverseCurve, direction, FILL, Fill, Layer} from './curves';

const u8 		= binary.UINT8;
const u16 		= binary.UINT16_BE;
const s16 		= binary.INT16_BE;
const u32 		= binary.UINT32_BE;
const u24		= binary.UINT(24, true);

const fixed32	= binary.asFixed(u32, 16);
const fixed16	= binary.asFixed(u16, 14);

//-----------------------------------------------------------------------------
//	CPAL	Color Palette Table
//-----------------------------------------------------------------------------

export const CPAL = {
	version:			u16,
	numPaletteEntries:	u16,		//	Number of palette entries in each palette.
	numPalettes:		u16,		//	Number of palettes in the table.
	numColorRecords:	u16,		//	Total number of color records, combined for all palettes.
	colors:	binary.Offset(u32, binary.Array(s => s.obj.numColorRecords, {
		b: u8,
		g: u8,
		r: u8,
		a: u8,
	})),
	colorRecordIndices:	binary.RemainingArray(u16),	//	Index of each palette's first color record in the combined color record array.

	v1:	binary.Optional(s => s.obj.version >= 1, {
		types:				binary.Offset(u32, binary.asEnum(u16, {
			USABLE_WITH_LIGHT_BACKGROUND:	0x0001,
			USABLE_WITH_DARK_BACKGROUND:	0x0002
		})),
		paletteLabels:		binary.Offset(u32, u16),	//Array of 'name' table IDs (typically in the font-specific name ID range) that specify user interface strings associated with each palette. Use 0xFFFF if no name ID is provided for a palette.
		paletteEntryLabels:	binary.Offset(u32, u16),	//Array of 'name' table IDs (typically in the font-specific name ID range) that specify user interface strings associated with each palette entry, e.g. 'Outline', 'Fill'. This set of palette entry labels applies to all palettes in the font. Use 0xFFFF if no name ID is provided for a palette entry.
	}),
};

//-----------------------------------------------------------------------------
//	COLR	Color Table
//-----------------------------------------------------------------------------

const enum PAINT {
	ColrLayers					= 1,
	Solid						= 2,	VarSolid,
	LinearGradient				= 4,	VarLinearGradient,
	RadialGradient				= 6,	VarRadialGradient,
	SweepGradient				= 8,	VarSweepGradient,
	Glyph						= 10,
	ColrGlyph					= 11,
	Transform					= 12,	VarTransform,
	Translate					= 14,	VarTranslate,
	Scale						= 16,	VarScale,
	ScaleAroundCenter			= 18,	VarScaleAroundCenter,
	ScaleUniform				= 20,	VarScaleUniform,
	ScaleUniformAroundCenter	= 22,	VarScaleUniformAroundCenter,
	Rotate						= 24,	VarRotate,
	RotateAroundCenter			= 26,	VarRotateAroundCenter,
	Skew						= 28,	VarSkew,
	SkewAroundCenter			= 30,	VarSkewAroundCenter,
	Composite					= 32,
};

const ColorLine = {
	extend:		u8,
	stops:		binary.Array(u16, {
		stopOffset:		fixed16,	   // Position on a color line
		paletteIndex:	u16,
		alpha:			fixed16,
	}),
};


export class PaintContext {
	layers:		Layer[]	= [];
	transform		= float2x3.identity();
	private curves: curveVertex[]	= [];

	constructor(public font: Font, public COLR: COLR, public palette?: color[]) {}

	getLayers(start: number, length: number) {
		return this.COLR!.v1!.layers!.slice(start, start + length);
	}
	getGlyph(id: number) {
		return this.font.getGlyph(id);
	}
	getCOLRGlyph(id: number) {
		const	base	= this.COLR!.v1!.baseGlyphs!;
		return base[id].paint;
	}
	getColour(i: number) {
		return this.palette![i];
	}

	getColourA(i: number, alpha: number) {
		const	c = this.getColour(i);
		c.a *= alpha;
		return c;
	}

	addCurves(v: curveVertex[]) {
		this.curves.push(...v);
	}
	addLayer(fill: Fill) {
		if (this.curves.length) {
			const sub: Layer = {
				curves: this.curves,
				fill: fill,
			};
			this.layers.push(sub);
			this.curves = [];
			return sub;
		}
	}

	makeGradient(line: binary.ReadType<typeof ColorLine>) {
		return {
			stops:	line.stops.map(i => ({color: this.getColourA(i.paletteIndex, i.alpha), stop:i.stopOffset})),
			extend:	line.extend,
			transform: this.transform
		};
	}
}

abstract class Paint {
	static put(_file: binary._stream, _v: Paint) {}
	abstract apply(ctx: PaintContext): void;
	constructor(..._args: any[]) {}
	
}

abstract class SubPaint extends Paint {
	paint:		Paint;
	constructor(file: binary._stream) {
		super();
		this.paint	= ReadPaint(file);
	}
}

class PaintColrLayers extends binary.Class({
	numLayers:			u8,		// Number of offsets to paint tables to read from LayerList
	firstLayerIndex:	u32,	// Index (base 0) into the LayerList
}) {
	//static get(s: binary._stream) { return new this(s); }
	apply(ctx: PaintContext) {
		for (const i of ctx.getLayers(this.firstLayerIndex, this.numLayers))
			i.apply(ctx);
	}
}

class PaintSolid extends binary.Class({
	paletteIndex:	u16,
	alpha:			fixed16,
}) {
	//static get(s: binary._stream) { return new this(s); }
	apply(ctx: PaintContext) {
		ctx.addLayer({type: FILL.SOLID, color: ctx.getColour(this.paletteIndex)});
	}
}

class PaintLinearGradient extends binary.Class({
	colorLine:	binary.Offset(u24, ColorLine),
	p0:	vec2(s16),			// Start point
	p1:	vec2(s16),			// End point
	p2:	vec2(s16),			// Rotation point
}) {
	//static get(s: binary._stream) { return new this(s); }
	apply(ctx: PaintContext) {
		ctx.addLayer({
			type:		FILL.LINEAR,
			p0: 		this.p0,
			p1: 		this.p1,
			p2:			this.p2,
			gradient:	ctx.makeGradient(this.colorLine)
		});
	}
}

class PaintRadialGradient extends binary.Class({
	colorLine:		binary.Offset(u24, ColorLine),
	start_centre: 	vec2(s16), start_radius: u16,
	end_centre: 	vec2(s16), end_radius: u16,
}) {
	//static get(s: binary._stream) { return new this(s); }
	apply(ctx: PaintContext) {
		ctx.addLayer({
			type:		FILL.RADIAL,
			c0:			new circle(this.start_centre, this.start_radius),
			c1:	 		new circle(this.end_centre, this.end_radius),
			gradient:	ctx.makeGradient(this.colorLine)
		});
	}
}

class PaintSweepGradient extends binary.Class({
	colorLine:	binary.Offset(u24, ColorLine),
	center:		vec2(s16),
	startAngle:	fixed16,
	endAngle:	fixed16,
}) {
	//static get(s: binary._stream) { return new this(s); }
	apply(ctx: PaintContext) {
		ctx.addLayer({
			type:		FILL.SWEEP,
			p0:			this.center,
			angle0:		this.startAngle,
			angle1:		this.endAngle,
			gradient:	ctx.makeGradient(this.colorLine)
		});
	}
}

export const enum MODE {
	// Porter-Duff modes
	CLEAR			= 0,	// No regions are enabled.
	SRC				= 1,	// Only the source will be present.
	DEST			= 2,	// Only the destination will be present
	SRC_OVER		= 3,	// Source is placed over the destination
	DEST_OVER		= 4,	// Source is placed over the destination
	SRC_IN			= 5,	// The source that overlaps the destination, replaces the destination
	DEST_IN			= 6,	// Destination which overlaps the source, replaces the source
	SRC_OUT			= 7,	// Source is placed, where it falls outside of the destination
	DEST_OUT		= 8,	// Destination is placed, where it falls outside of the source
	SRC_ATOP		= 9,	// Source which overlaps the destination, replaces the destination. Destination is placed elsewhere
	DEST_ATOP		= 10,	// Destination which overlaps the source replaces the source. Source is placed elsewhere
	XOR				= 11,	// The non-overlapping regions of source and destination are combined
	PLUS			= 12,	// Display the sum of the source image and destination image ('Lighter' in Composition & Blending Level 1)
	// Separable color blend modes:
	SCREEN			= 13,	// D + S - (D * S)
	OVERLAY			= 14,	// HardLight(S, D)
	DARKEN			= 15,	// min(D, S)
	LIGHTEN			= 16,	// max(D, S)
	COLOR_DODGE		= 17,	// D == 0 ? 0 : S == 1 ? 1 : min(1, D / (1 - S))
	COLOR_BURN		= 18,	// D == 1 ? 1 : S == 0 ? 0 : 1 - min(1, (1 - D) / S)
	HARD_LIGHT		= 19,	// S <= 0.5 ? Multiply(D, 2 * S) : Screen(D, 2 * S - 1)  
	SOFT_LIGHT		= 20,	// S <= 0.5 ? D - (1 - 2 * S) * D * (1 - D) : D + (2 * S - 1) * (T(D) - D); where T(C) = C <= 0.25 ? ((16 * C - 12) * C + 4) * C : sqrt(C)
	DIFFRENCE		= 21,	// | D - S |
	EXCLUSION		= 22,	// D + S - 2 * D * S
	MULTIPLY		= 23,	// D * S
	// Non-separable color blend modes:
	HUE				= 24,	// SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))
	SATURATION		= 25,	// SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))
	COLOR			= 26,	// SetLum(Cs, Lum(Cb))
	LUMINOSITY		= 27,	// SetLum(Cb, Lum(Cs))
};

class PaintComposite extends SubPaint {
	mode:		MODE;
	backdrop:	Paint;
	static get(file: binary._stream) { return new this(file); }
	constructor(file: binary._stream) {
		super(file);
		this.mode		= u8.get(file);
		this.backdrop	= ReadPaint(file);
	}
	apply(_ctx: PaintContext) {}
}

class PaintColrGlyph extends binary.Class({
	glyphID:	u16,		// Glyph ID for a BaseGlyphList base glyph
}) {
	//static get(s: binary._stream) { return new this(s); }
	apply(ctx: PaintContext) {
		ctx.getCOLRGlyph(this.glyphID).apply(ctx);
	}
}
//type XX = binary.ReadType<PaintColrGlyph>;

class PaintGlyph extends SubPaint {
	glyphID:	number;		// Glyph ID for the source outline

	static get(file: binary._stream) { return new this(file); }

	constructor(file: binary._stream) {
		super(file);
		this.glyphID = binary.read(file, u16);
	}
	apply(ctx: PaintContext) {
		const	g = ctx.getGlyph(this.glyphID);
		if (g) {
			let		curve = g.curve!;

			if (!curve && g.refs)
				curve = g.refs.reduce((all, r) => [...all, ...transformCurve(ctx.getGlyph(r.glyph)?.curve, r.mat)], [] as curveVertex[]);

			if (direction(curve) !== (ctx.transform.det() < 0))
				reverseCurve(curve);

			ctx.addCurves(transformCurve(curve, ctx.transform));
			this.paint.apply(ctx);
		}
	}
}

const Affine2x3 = binary.as(
	binary.Offset(u24, {x: vec2(fixed32), y: vec2(fixed32), d: vec2(fixed32)}),
	v => v ? float2x3(v.x, v.y, v.d) : float2x3.identity()
);
const Translate		= binary.as(vec2(s16), 		v => float2.translate(v));
const Scale			= binary.as(vec2(fixed16),	v => float2.scale(v));
const ScaleUniform	= binary.as(fixed16,		v => float2.scale(v));
const Rotate		= binary.as(fixed16,		v => float2.rotate(v));
const Skew 			= binary.as(vec2(fixed16),	v => float2x2(float2(1, v.y), float2(v.x, 1)));

function WithCentre(transform: binary.TypeT<float2x3|float2x2>) {
	return binary.as({transform, center: vec2(s16)}, x =>
		float2x3(x.transform.x, x.transform.y, x.center.add(x.transform.mulPos(x.center.neg())))
	);
}

class PaintTransformBase extends SubPaint {
	transform:	float2x3|float2x2;
	static get(file: binary._stream) { return new this(file, Affine2x3); }
	constructor(file: binary._stream, transform: binary.TypeT<float2x3|float2x2>) {
		super(file);
		this.transform = binary.read(file, transform);
	}
	apply(ctx: PaintContext) {
		const save = ctx.transform.mulAffine(this.transform);
		this.paint.apply(ctx);
		ctx.transform = save;
	}
}

function PaintTransform(transform: binary.TypeT<float2x3|float2x2>) {
	return class extends PaintTransformBase {
		static get(file: binary._stream) { return new this(file); }
		constructor(file: binary._stream) {
			super(file, transform);
		}
	};
}

function Var<T extends new(...args: any[])=>any>(t: T) {
	return class extends t {
		static get(file: binary._stream) { return new this(file); }
		varIndexBase: number;
		constructor(...args: any[]) {
            super(args);
			this.varIndexBase = u32.get(args[0]);
		}
	};
}
//	 return {...t, varIndexBase:	u32}; }  // Base index into DeltaSetIndexMap.

const PaintBase = binary.Switch(u8, {
	[PAINT.ColrLayers]:					PaintColrLayers,// as unknown as binary.TypeT<Paint>,
	[PAINT.Glyph]:						PaintGlyph,
	[PAINT.ColrGlyph]:					PaintColrGlyph,
	[PAINT.Composite]:					PaintComposite,

	[PAINT.Solid]:						PaintSolid,
	[PAINT.LinearGradient]:				PaintLinearGradient,
	[PAINT.RadialGradient]:				PaintRadialGradient,
	[PAINT.SweepGradient]:				PaintSweepGradient,

	[PAINT.Transform]: 					PaintTransform(Affine2x3),
	[PAINT.Translate]: 					PaintTransform(Translate),
	[PAINT.Scale]: 						PaintTransform(Scale),
	[PAINT.ScaleUniform]: 				PaintTransform(ScaleUniform),
	[PAINT.Rotate]: 					PaintTransform(Rotate),
	[PAINT.Skew]: 						PaintTransform(Skew),
	[PAINT.ScaleAroundCenter]:			PaintTransform(WithCentre(Scale)),
	[PAINT.ScaleUniformAroundCenter]:	PaintTransform(WithCentre(ScaleUniform)),
	[PAINT.RotateAroundCenter]:			PaintTransform(WithCentre(Rotate)),
	[PAINT.SkewAroundCenter]:			PaintTransform(WithCentre(Skew)),

	[PAINT.VarSolid]:					Var(PaintSolid),
	[PAINT.VarLinearGradient]:			Var(PaintLinearGradient),
	[PAINT.VarRadialGradient]:			Var(PaintRadialGradient),
	[PAINT.VarSweepGradient]:			Var(PaintSweepGradient),

	[PAINT.VarTransform]: 				Var(PaintTransform(Affine2x3)),
	[PAINT.VarTranslate]:				Var(PaintTransform(Translate)),
	[PAINT.VarScale]:					Var(PaintTransform(Scale)),
	[PAINT.VarScaleUniform]:			Var(PaintTransform(ScaleUniform)),
	[PAINT.VarRotate]:					Var(PaintTransform(Rotate)),
	[PAINT.VarSkew]:					Var(PaintTransform(Skew)),
	[PAINT.VarScaleAroundCenter]:		Var(PaintTransform(WithCentre(Scale))),
	[PAINT.VarScaleUniformAroundCenter]:Var(PaintTransform(WithCentre(ScaleUniform))),
	[PAINT.VarRotateAroundCenter]:		Var(PaintTransform(WithCentre(Rotate))),
	[PAINT.VarSkewAroundCenter]:		Var(PaintTransform(WithCentre(Skew))),
});

function ReadPaint(file: binary._stream) : Paint {
	const base	= binary.read(file, binary.Offset(u24, PaintBase));
	return base as unknown as Paint;
}

export class COLR extends binary.Class({
	version:				u16,
	numBaseGlyphRecords:	u16,
	baseGlyphs:				binary.Offset(u32, binary.Array(s => s.obj.numBaseGlyphRecords, {
		glyphID:			u16,	// Glyph ID of the base glyph
		firstLayerIndex:	u16,	// Index (base 0) into the layerRecords array
		numLayers:			u16,	// Number of color layers associated with this glyph
	})),
	layers:					binary.Offset(u32, binary.Array(s => s.obj.numLayerRecords, {
		glyphID:			u16,	// Glyph ID of the glyph used for a given layer
		paletteIndex:		u16,	// Index (base 0) for a palette entry in the CPAL table
	})),
	numLayerRecords:		u16,

	v1:	binary.Optional(s => s.obj.version === 1, {
		baseGlyphs:		binary.Offset(u32, binary.Array(u32, {
			glyphID:	u16,		// Glyph ID of the base glyph
			paint:		binary.Offset(u32, PaintBase),
		})),

		layers:			binary.Offset(u32, binary.Array(u32, binary.Offset(u32, PaintBase))),
		clips:			binary.Offset(u32, {
			format:		u8,
			clips:		binary.Array(u32, {
				startGlyphID:	u16,
				endGlyphID:		u16,
				clipBox:		binary.Offset(u24, {
					format:	u8,
					xMin:	s16, yMin: s16, xMax: s16, yMax: s16,
				}),
			}),
		}, true),
		varIndexMapOffset:			u32,	// Offset to DeltaSetIndexMap table (may be NULL)
		itemVariationStoreOffset:	u32,	// Offset to ItemVariationStore> (may be NULL)
	}),
}) {
	//static get(s: binary._stream) { return new this(s); }
	getGlyph(font: Font, cpal: binary.ReadType<typeof CPAL>|undefined, id: number) {
		if (this.v1) {
			const	base	= this.v1.baseGlyphs;
			for (const i of base) {
				if (i.glyphID === id) {
					const ctx = new PaintContext(font, this, cpal?.colors?.slice(cpal?.colorRecordIndices[0]));
					i.paint.apply(ctx);
					return ctx.layers;
				}
			}
		}
	}
}

