"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs/promises"));
const fontbin = __importStar(require("../dist"));
(async () => {
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
//# sourceMappingURL=testfont.js.map