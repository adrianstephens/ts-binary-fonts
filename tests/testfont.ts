
import * as fs from 'fs/promises';
import * as fontbin from '../dist';

(async() => {
	// Load a font file
	//const font = await fontbin.loadFile('/Users/adrianstephens/Downloads/cbdt.ttf');
	const font = await fontbin.loadFile('c:\\Windows\\Fonts\\ALGER.TTF');

	if (font && font instanceof fontbin.Font) {

		// Access font properties
		console.log(font.numGlyphs());

		const image = font.getGlyphImage(3, 1024);
		if (image)
			await fs.writeFile('./glyph.png', image.data);


		const mapping = font.getGlyphMapping();
		if (mapping) {
			const id = mapping['f'.charCodeAt(0)];
			const svg = font.getGlyphSVG(id);
			if (svg)
				await fs.writeFile('./glyph.svg', svg.toString());
		}
	}
})();
