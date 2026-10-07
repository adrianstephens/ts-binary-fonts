# fontTools' view of a font, as JSON on stdout: for every glyph the coordinates and flags of what it draws (composites
# resolved), so that what binary_fonts reads or writes can be checked against a reader that is not it.
#   python glyphs.py font.(ttf|woff|woff2) [--convert-to out.(ttf|woff|woff2)]
import json, sys
from fontTools.ttLib import TTFont

font = TTFont(sys.argv[1])
if '--convert-to' in sys.argv:
    out = sys.argv[sys.argv.index('--convert-to') + 1]
    font.flavor = 'woff2' if out.endswith('woff2') else 'woff' if out.endswith('woff') else None
    font.save(out)
    sys.exit(0)
glyf = font['glyf']
result = {}
for name in font.getGlyphOrder():
    g = glyf[name]
    if g.numberOfContours == 0:
        result[name] = {'contours': 0}
        continue
    coords, ends, flags = g.getCoordinates(glyf)
    result[name] = {'coords': [list(c) for c in coords], 'ends': list(ends), 'on': [f & 1 for f in flags],
                    'composite': g.isComposite(), 'components': [(c.glyphName, c.x, c.y, c.flags & 0xFFF) for c in g.components] if g.isComposite() else []}
print(json.dumps({'order': font.getGlyphOrder(), 'glyphs': result, 'hmtx': {k: list(v) for k, v in font['hmtx'].metrics.items()}}))
