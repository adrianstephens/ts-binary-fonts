# Binary Fonts
[![npm version](https://img.shields.io/npm/v/@isopodlabs/binary.svg)](https://www.npmjs.com/package/@isopodlabs/binary_fonts)
[![GitHub stars](https://img.shields.io/github/stars/adrianstephens/binary_font.svg?style=social)](https://github.com/adrianstephens/binary_font)
[![License](https://img.shields.io/npm/l/@isopodlabs/binary_fonts.svg)](LICENSE.txt)

This package provides readers for various font formats, using the @isopodlabs/binary, and the @isopodlabs/xml libraries.

It supports reading type 1, TTF, SVG, bitmap and color glyphs.

Non bitmap glyphs can be converted to SVGs.


## ☕ Support My Work  
If you use this package, consider [buying me a cup of tea](https://coff.ee/adrianstephens) to support future updates!  

## Usage
Here's an example of how to use the binary_font package to read a font file and output an svg for the glyph representing 'A':
```typescript
import { readFileSync, writeFileSync } from 'fs';
import { load, Font } from '@isopodlabs/binary_font';

// Load a font file
const fontData = readFileSync('path/to/font.ttf');

// Parse the font
const font = load(fontData);
if (font && font instanceof Font) {

    // Access font properties
    console.log(font.numGlyphs());

    const mapping = font.getGlyphMapping();
	if (mapping) {
        const id = mapping['A'.charCodeAt(0)];
        const svg = font.getGlyphSVG(id);
		if (svg)
			writeFileSync('./glyph.svg', svg.toString());
    }
}

```

### Browser
For browser code, import the browser entry and provide the font bytes yourself:

```typescript
import { load, Font } from '@isopodlabs/binary_fonts/browser';

const data = new Uint8Array(await fetch('/fonts/example.woff2').then(r => r.arrayBuffer()));
const font = await load(data);

if (font instanceof Font) {
    const mapping = font.getGlyphMapping();
    const id = mapping?.['A'.charCodeAt(0)];
    if (id !== undefined)
        console.log(font.getGlyphSVG(id)?.toString());
}
```

The browser entry configures WOFF and WOFF2 decompression using `DecompressionStream` when available. The default package entry still includes `loadFile`, which is Node-only.

## Supported File Types
The binary_font package supports reading and parsing the following font formats:

- TrueType Fonts (TTF)
- TrueType Collections (TTC)
- OpenType Fonts (OTF)
- Web Open Font Format (WOFF)
- Web Open Font Format 2 (WOFF2)

The following data blocks are supported:

- OS/2  OS/2 and Windows Metrics Table
- head  Font Header Table
- hhea  Horizontal Header Table
- hmtx  Horizontal Metrics Table
- vhea  Vertical Header Table
- vmtx  Vertical Metrics Table
- maxp  Maximum Profile
- name  Naming Table
- cmap  Character to Glyph Index Mapping Table
- gasp  Grid-fitting and Scan-conversion Procedure Table
- sbix  Standard Bitmap Graphics Table
- EBLC  Embedded Bitmap Location Table
- EBDT  Embedded Bitmap Data Table
- CBLC  Color Bitmap Location Table
- CBDT  Color Bitmap Data Table
- GSUB  Glyph Substitution Table
- GPOS  Glyph Positioning Table
- CPAL  Color Palette Table
- COLR  Color Table
- SVG   Scalable Vector Graphics
- CFF   Compact Font Format
- DSIG  Digital Signature Table

## API

### Interfaces
```typescript
// a 2D vector
interface float2 {
    x: number;
    y: number;
};

// a vertex of a curve. An array of these defines one or multiple curves
class curveVertex extends float2 {
	static readonly ON_BEGIN	= 0;    // this vertex starts a new curve
	static readonly ON_CURVE	= 1;    // this vertex is on the curve
	static readonly OFF_BEZ2	= 2;    // this vertex is the control point of a quadratic bezier
	static readonly OFF_BEZ3	= 3;    // this vertex is a control point of a cubic bezier
	static readonly OFF_ARC		= 8;
	static readonly ON_ARC		= 9;
	flags: number;
}

// reference to another glyph with a transformation
interface glyphRef {
	glyph: number;
	mat: {x: float2, y: float2, z: float2};
}

// a single glyph in a font
interface Glyph {
    min: float2;
    max: float2;
    curve?: curveVertex[];      // a curve or curves
    refs?: glyphRef[];          // references to other glyphs
    instructions?: Uint8Array;  // additional instructions used to define a glyph
}

// a single glyph in a bitmap font
interface GlyphImage {
    originOffset: float2;       // position of the left edge of the bitmap graphic in relation to the glyph design space origin
    graphicType: string;        // one of 'jpg ', 'png ', or 'tiff' describing the image format in the data
    data: Uint8Array;
}
```

### Font
The Font class provides methods to access font properties and glyph data.
#### Methods
- `numGlyphs(): number`

    Returns the number of glyphs in the font.
- `getGlyph(id: number): Glyph | undefined`

    Returns the glyph data for the specified glyph ID.
- `getGlyphMapping(): number[] | undefined`

    Returns the glyph mapping array.
- `getGlyphImage(id: number, ppem: number): GlyphImage | undefined`

    Returns the glyph image for the specified glyph ID at the specified pixels per em (ppem).
- `getGlyphCOLR(id: number): Layer[] | undefined`

    Returns the COLR layers for the specified glyph ID.
- `getGlyphSVG(id: number, preferCOLR?: boolean): xml.Element | undefined`

    Returns the SVG representation of the specified glyph ID.
#### Properties
Each block found in the font exists as a property on the Font class. The properties are typed according to the specs used to read them.

### FontGroup
The FontGroup holds an array of Fonts read from, say, a TTC file
#### Methods
- `getSub(sub: string): Font | undefined`

    Returns the font with the matching name.

#### Properties
- `fonts: Font[]`

    The array of fonts.

### Functions
- `load(data: Uint8Array): Font | FontGroup | Promise<Font> | undefined`

    Loads the font data from the given data array.
    The WOFF and WOFF2 formats return a `Promise`; other formats are synchronous.

## License

This project is licensed under the MIT License.