/* eslint-disable no-debugger */
import * as bin from '@isopodlabs/binary';
import {Font, SFNTHeader, loadLocs, loadMetrics, ID, name} from './font';
import {WOFF, WOFF2} from './woff';
import {layout} from './write';

export {WOFF, WOFF2} from './woff';
export {Font, Glyph, GlyphImage, GlyphRef, GlyphSnapshot, Metrics, ID} from './font';
export {curveVertex, bezier2Curve, bezier3Curve, type CurveSink, type CurveSource, makeCurveVertex, parseCurve, transformCurve, mapCurve, curvepathDistance2} from './curves';

export interface FontGroup {
	fonts: Font[];
	getSub(sub: string): Font | undefined;
}

export interface AsyncFont {
	family():		string | undefined;
	subfamily():	string;
	get():			Promise<Font>;
}

export interface AsyncFontGroup {
	fonts: Promise<AsyncFont>[];
	getSub(sub: string): Promise<AsyncFont | undefined>;
}

const TAG		= bin.String(4);
const u32 		= bin.UINT32_BE;

//-----------------------------------------------------------------------------
//	TTF
//-----------------------------------------------------------------------------


export class TTF_OTF extends Font {
	constructor(file: bin.stream) {
		super();
		const sfnt	= file.read(SFNTHeader);

		this.sfntVersion = sfnt.version;
		for (const {tag} of sfnt.tables) {
			const table = sfnt.getTable(tag, file);
			if (table)
				this.loadTable(tag, table);
		}

		const loca	= sfnt.getTable('loca', file);
		const glyf	= sfnt.getTable('glyf', file);
		if (loca && glyf)
			this.glyphdata = loadLocs(loca, glyf, this.head!.indexToLocFormat);

		const hmtx = sfnt.getTable('hmtx', file);
		if (hmtx && this.hhea)
			this.hmtx = loadMetrics(hmtx, this.numGlyphs(), this.hhea.numOfLongMetrics);
	}
	// the font, whatever it was read from, as an SFNT file: its directory, then the tables where the directory says they are
	static write(font: Font) {
		const {tables, header, size} = layout(font);
		const file = new bin.growingStream();
		header.write(file);
		for (const e of header.tables) {
			file.seek(e.offset);
			file.write_view(tables.get(e.tag)!);
		}
		file.write_view(new Uint8Array(size - file.tell()));		// the last table is padded to four bytes like the rest
		return file.terminate();
	}

	save() {
		return TTF_OTF.write(this);
	}
}

async function asyncLoadTTF_OTF(file: bin.async._stream) {
	const sfnt	= await file.read(SFNTHeader);
	const n0	= sfnt.getTable('name', file);
	const n		= n0 ? new name(new bin.stream(await n0)) : undefined;
	return {
		family(): string | undefined { return n?.get(ID.PREF_FAMILY) ?? n?.get(ID.FAMILY); },
		subfamily(): string { return n?.get(ID.PREF_SUBFAMILY) ?? n?.get(ID.SUBFAMILY) ?? 'Regular'; },
		get: async () => {
			const font = new Font;
			font.sfntVersion = sfnt.version;
			for (const {tag} of sfnt.tables) {
				const table = sfnt.getTable(tag, file);
				if (table)
					font.loadTable(tag, await table);
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
//	load
//-----------------------------------------------------------------------------

export async function loadAsync(file: bin.async.stream) : Promise<AsyncFont | AsyncFontGroup | undefined> {
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

		case 'ttcf': {
			const _version	= await u32.get(file);	// Version of the TTC Header (1.0), 0x00010000 or (2.0), 0x00020000
			const offsets	= await bin.interop.readn(file, u32, await u32.get(file));
			// A collection's table records are absolute from the start of the file, not from the face, so a face
			// stream keeps the file's origin and moves only its cursor: offsetStream(offset) shifts the origin too,
			// which makes every view_at(table.offset) land `offset` bytes past the table it names. The faces also
			// share this stream's buffer (offsetStream reuses its viewDelegate), so reading them concurrently lets
			// one face's expand() overwrite bytes another face's view still points at -- hence one at a time.
			const fonts: Promise<AsyncFont>[] = [];
			for (const offset of offsets) {
				const face = file.offsetStream(0);
				face.seek(offset);
				fonts.push(Promise.resolve(await asyncLoadTTF_OTF(face)));
			}
			return {
				fonts,
				getSub: async (s: string) => {
					for (const font of fonts) {
						const face = await font;
						if (face.subfamily() === s)
							return face;
					}
				}
			};
		}

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
			return new TTF_OTF(file);

		case 'ttcf': {
			const _version	= u32.get(file);	// Version of the TTC Header (1.0), 0x00010000 or (2.0), 0x00020000
			const offsets	= bin.readn(file, u32, u32.get(file));
			// the table records of a face are from the start of the file, so the stream keeps the file's origin and only its cursor moves
			const fonts		= offsets.map(offset => { file.seek(offset); return new TTF_OTF(file); });
			return {
				fonts,
				getSub: (s:string) => fonts.find(i => i.subfamily() === s)
			};
		}

		case 'wOFF':
			file.seek(0);
			return WOFF.load(file);
		case 'wOF2':
			file.seek(0);
			return WOFF2.load(file);
	}
}


