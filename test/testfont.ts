
import * as fs from 'fs/promises';
import * as path from 'path';
import * as fontbin from '../dist';

(async() => {
	// Load a font file
	//const font = await fontbin.loadFile('/Users/adrianstephens/Downloads/cbdt.ttf');
//	const font = await fontbin.loadFile('c:\\Windows\\Fonts\\ALGER.TTF');
	const font = await fontbin.loadFile(path.join(__dirname, 'ALGER.TTF'));

	if (font && font instanceof fontbin.Font) {
		const names = font.name;

		// Access font properties
		console.log(font.numGlyphs());

		const image = font.getGlyphImage(3, 1024);
		if (image)
			await fs.writeFile(path.join(__dirname, 'glyph.png'), image.data);


		const mapping = font.getGlyphMapping();
		if (mapping) {
			const id = mapping['f'.charCodeAt(0)];
			const svg = font.getGlyphSVG(id);
			if (svg)
				await fs.writeFile(path.join(__dirname, 'glyph.svg'), svg.toString());
		}
	}
})();
