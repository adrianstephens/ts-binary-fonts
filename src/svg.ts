import * as xml from '@isopodlabs/xml';
import { float2, float2x3 } from '@isopodlabs/maths/vector';
import { bezier3Curve, parseCurve, makeCurve, transformCurve, curveExtent, type curveVertex, type CurveSink, type CurveSource, type Layer, ArcParams, color, FILL, Fill, EXTEND,
	putRect, putRoundedRect, putEllipse, putPolygon,
} from './curves';

const numbers = (text: string | undefined) => (text?.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
const length = (text: string | undefined, fallback = 0) => text === undefined ? fallback : (numbers(text)[0] ?? fallback);


function findById(e: xml.Element, id: string): xml.Element | undefined {
	if (e.attributes.id === id)
		return e;
	for (const i of e.allElements()) {
		const found = findById(i, id);
		if (found)
			return found;
	}
}

// the ids a subtree refers to, by url(#...) in attributes and styles or by href
function referencedIds(e: xml.Element, ids = new Set<string>()) {
	for (const [name, value] of Object.entries(e.attributes)) {
		if (typeof value !== 'string')
			continue;
		if (name === 'href' || name === 'xlink:href') {
			const m = /^#(.+)$/.exec(value);
			if (m)
				ids.add(m[1]);
		}
		for (const m of value.matchAll(/url\(\s*['"]?#([^)'"]+)['"]?\s*\)/g))
			ids.add(m[1]);
	}
	for (const i of e.allElements())
		referencedIds(i, ids);
	return ids;
}

function retarget(e: xml.Element, from: string, to: string) {
	for (const [name, value] of Object.entries(e.attributes))
		if (typeof value === 'string' && (name !== 'id'))
			e.attributes[name] = value.replace(new RegExp(`#${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g'), `#${to}`);
	e.allElements().forEach(i => retarget(i, from, to));
}

//-----------------------------------------------------------------------------
//	SVG paths
//-----------------------------------------------------------------------------

export function makeSVGPath(source: CurveSource) {
	const commands: { command: string, params: number[]; }[] = [];

	// the y flip mirrors the arc: the rotation and the sweep direction both reverse
	function arc(ap: ArcParams, end: float2) {
		commands.push({command: 'A', params: [ap.radii.x, ap.radii.y, -ap.angle * 180 / Math.PI, ap.big ? 1 : 0, ap.clockwise ? 0 : 1, end.x, -end.y]});
	}
	
	source.run({
		Begin(a) 				{ commands.push({command: 'M', params: [a.x, -a.y]}); },
		End()					{ commands.push({command: 'Z', params: []}); },
		Line(_a, b)	 			{ commands.push({command: 'L', params: [b.x, -b.y]}); },
		Bezier2(_a, b, c)		{ commands.push({command: 'Q', params: [b.x, -b.y, c.x, -c.y]}); },
		Bezier3(_a, b, c, d)	{ commands.push({command: 'C', params: [b.x, -b.y, c.x, -c.y, d.x, -d.y]}); },
		Arc3(a, b, c)			{ arc(ArcParams.make1off(a, b, c), c); },
		Arc(a, b, c, d)			{ arc(ArcParams.make2off(a, b, c, d), d); },
	});
	return commands.map(c => c.command + c.params.map(i => i.toString()).join(',')).join('');
}

// SVG path data. Coordinates are used as written (makeSVGPath's y flip is not undone). Subpaths are closed implicitly,
// as parseCurve closes them, unless keepOpen, which adds no closing segment and tells End whether the subpath was open.
export function parseSVGpath(path: string, keepOpen = false): CurveSource {
	const arity: Record<string, number> = {m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0};
	const number = /\s*,?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
	const flag = /\s*,?\s*([01])/y;

	return {
		run(sink0) {
			const sink: CurveSink = {Begin() {}, End() {}, Line() {}, Bezier2() {}, Bezier3() {}, Arc() {}, Arc3() {}, ...sink0};
			let	cur		= float2(0, 0);
			let	start	= cur;
			let	prevKind = '';
			let	ctrl: float2 | undefined;	// the previous curve's last control point, for the smooth commands
			let	open	= false;
			let	pos		= 0;

			const close = (explicit = false) => {
				if (open) {
					if (!keepOpen && (cur.x !== start.x || cur.y !== start.y))
						sink.Line(cur, start);
					sink.End(keepOpen && !explicit);
					cur		= start;
					open	= false;
				}
			};
			const begin = (p: float2) => {
				close();
				sink.Begin(cur = start = p);
				open = true;
			};
			const read = (re: RegExp) => {
				re.lastIndex = pos;
				const m = re.exec(path);
				if (!m)
					return NaN;
				pos = re.lastIndex;
				return parseFloat(m[1]);
			};
			const more = () => { number.lastIndex = pos; return number.test(path); };

			for (const m of path.matchAll(/[a-zA-Z]/g)) {
				if (m.index < pos)
					continue;
				pos = m.index + 1;
				let		cmd	= m[0];
				const	rel	= cmd === cmd.toLowerCase();
				const	n	= arity[cmd.toLowerCase()];
				if (n === undefined)
					break;

				if (n === 0) {
					close(true);
					ctrl = undefined;
					continue;
				}

				do {
					const	args: number[] = [];
					for (let i = 0; i < n; i++)
						args.push(read(cmd.toLowerCase() === 'a' && (i === 3 || i === 4) ? flag : number));
					if (args.some(isNaN))
						return;

					const	ox = rel ? cur.x : 0, oy = rel ? cur.y : 0;
					const	pt = (i: number) => float2(args[i] + ox, args[i + 1] + oy);
					const	c = cmd.toLowerCase();

					if (c === 'm') {
						begin(pt(0));
						ctrl = undefined;
						cmd = rel ? 'l' : 'L';		// further pairs are implicit lines
						continue;
					}
					if (!open)
						begin(cur);

					const	from = cur;
					let		next = ctrl;
					switch (c) {
						case 'l': sink.Line(from, cur = pt(0)); next = undefined; break;
						case 'h': sink.Line(from, cur = float2(args[0] + ox, from.y)); next = undefined; break;
						case 'v': sink.Line(from, cur = float2(from.x, args[0] + oy)); next = undefined; break;
						case 'q': {
							const	b = pt(0);
							sink.Bezier2(from, b, cur = pt(2));
							next = b;
							break;
						}
						case 't': {
							const	b = ctrl && prevKind === 'q' ? from.add(from.sub(ctrl)) : from;
							sink.Bezier2(from, b, cur = pt(0));
							next = b;
							break;
						}
						case 'c': {
							const	b = pt(2);
							sink.Bezier3(from, pt(0), b, cur = pt(4));
							next = b;
							break;
						}
						case 's': {
							const	b = pt(0);
							sink.Bezier3(from, ctrl && prevKind === 'c' ? from.add(from.sub(ctrl)) : from, b, cur = pt(2));
							next = b;
							break;
						}
						case 'a': {
							const	to = pt(5);
							const	rx = Math.abs(args[0]), ry = Math.abs(args[1]);
							cur = to;
							next = undefined;
							if (to.x === from.x && to.y === from.y)
								break;
							if (rx === 0 || ry === 0) {
								sink.Line(from, to);
								break;
							}
							// the flags are large-arc then sweep; sweep is the direction of increasing angle, which ArcParams calls clockwise
							const	ap = new ArcParams(float2(rx, ry), args[2] * Math.PI / 180, !!args[4], !!args[3]);
							const	cp = ap.control_points(from, to);
							sink.Arc(from, cp[0], cp[1], to);
							break;
						}
					}
					ctrl		= next;
					prevKind	= c === 'q' || c === 't' ? 'q' : c === 'c' || c === 's' ? 'c' : '';
				} while (more());
			}
			close();
		}
	};
}


/** The outline of a path or basic shape element as curve vertices, in its own coordinates (arcs as arc vertices, which
 *  bezier3Curve makes cubics of); undefined for any other element. Where `open` is set, a path's unclosed subpaths, a polyline
 *  and a line stay open, ended by ON_END; otherwise everything is closed, as filling closes it. */
export function parseSVGshape(e: {name: string, attributes: Record<string, any>}, open = false): CurveSource | undefined {
	const a = e.attributes;
	const point = (x: string, y: string) => float2(length(a[x]), length(a[y]));
	const nothing: CurveSource = {run() {}};
	switch (e.name) {
		case 'path':
			return parseSVGpath(typeof a.d === 'string' ? a.d : '', open);

		case 'rect': {
			const w = length(a.width), h = length(a.height);
			if (!(w > 0 && h > 0))
				return nothing;
			const p0 = point('x', 'y'), p1 = float2(p0.x + w, p0.y + h);
			// a corner radius given for one axis only is the radius of both
			const r = float2(Math.min(length(a.rx ?? a.ry), w / 2), Math.min(length(a.ry ?? a.rx), h / 2));
			return r.x > 0 && r.y > 0 ? putRoundedRect(p0, p1, r) : putRect(p0, p1);
		}
		case 'circle':
			return putEllipse(point('cx', 'cy'), float2.broadcast(length(a.r)));

		case 'ellipse':
			return putEllipse(point('cx', 'cy'), point('rx', 'ry'));

		case 'polygon': case 'polyline': {
			const p = numbers(a.points);
			return putPolygon(Array.from({length: Math.floor(p.length / 2)}, (_, i) => float2(p[2 * i], p[2 * i + 1])), !(open && e.name === 'polyline'));
		}
		case 'line':
			return open ? putPolygon([point('x1', 'y1'), point('x2', 'y2')], false) : nothing;
	}
}

//-----------------------------------------------------------------------------
//	SVG readers
//-----------------------------------------------------------------------------

export function makeSVG(children: xml.Element[], extent: float2.extent) {
	return new xml.Element('svg', {
		xmlns:			"http://www.w3.org/2000/svg",
		['xmlns:xlink']:"http://www.w3.org/1999/xlink",
		version:		"1.1",
		viewBox:		`${extent.min.x} ${extent.min.y} ${extent.extent().x} ${extent.extent().y}`,
		width:			extent.extent().x,
		height:			extent.extent().y
	}, children);
}

function SVGcolor(c: color) {
	return '#' + ((c.r << 16) + (c.g << 8) + (c.b << 0) + (1<< 24)).toString(16).slice(-6);
}
function SVGgradient(fill: Fill, id: string) {
	if (fill.type !== FILL.SOLID) {
		const stops = fill.gradient.stops.map(i => new xml.Element("stop", {offset: i.stop, 'stop-color': SVGcolor(i.color)}));
		const gradientUnits = 'userSpaceOnUse';
		const spreadMethod = fill.gradient.extend === EXTEND.REPEAT ? 'repeat' : fill.gradient.extend === EXTEND.REFLECT ? 'reflect' : undefined;

		switch (fill.type) {
			case FILL.LINEAR:
				return new xml.Element('linearGradient', {id, x1: fill.p0.x, y1: -fill.p0.y, x2: fill.p1.x, y2: -fill.p1.y, gradientUnits, spreadMethod}, stops);
			case FILL.SWEEP:
				return new xml.Element('sweepGradient', {gradientUnits, spreadMethod}, stops);//unsupported by svg
			case FILL.RADIAL:
				return new xml.Element('radialGradient', {id, fx: fill.c0.centre.x, fy: fill.c0.centre.y, fr: fill.c0.radius, cx: fill.c1.centre.x, cy: fill.c1.centre.y, r: fill.c1.radius, gradientUnits, spreadMethod}, stops);
		}
	}
}

export function SVGlayers(layers: Layer[]) {
	let id = 1;

	const extent	= new float2.extent;
	const defs		= new xml.Element('defs');
	const children	= [defs, ...layers.map(j => {
		const curve	= parseCurve(j.curve);
		const d		= makeSVGPath(curve);
		const fill	= j.fill.type === FILL.SOLID
			? SVGcolor(j.fill.color)
			: (defs.add(SVGgradient(j.fill, `g${id}`)!), `url(#g${id++})`);
		extent.combine(curveExtent(parseSVGpath(d)));
		return new xml.Element("path", {d, fill});
	})];

	return makeSVG(children, extent);
}

//-----------------------------------------------------------------------------
//	one glyph of an OpenType-SVG document
//-----------------------------------------------------------------------------

// A table document draws one or more glyphs, each the element with the id glyph<N>, in font units with y down, sharing the
// definitions (gradients, paths to use) of the document. These take a glyph out as a document of its own, and put an edited one back.

const compact: xml.OutputOptions = {indent: '', newline: ''};

/** One glyph of a document as a document of its own: its element and the definitions it uses, under the document's own
 *  attributes (with viewBox, if given, for the whole; else the document's, else the extent of the glyph's paths). Undefined where the document has no element for the glyph. */
export function extractGlyphElement(text: string, id: number) {
	const root = xml.parse(text).firstElement();
	const glyph = root && findById(root, `glyph${id}`);
	if (!root || !glyph)
		return;

	const attributes: xml.Attributes = {...root.attributes};
	delete attributes.id;
	delete attributes.width;
	delete attributes.height;
	// what the glyph uses that is outside it, and what that uses
	const defs = new xml.Element('defs');
	const done = new Set<string>();
	const pending = [...referencedIds(glyph)];
	while (pending.length) {
		const ref = pending.pop()!;
		if (done.has(ref))
			continue;
		done.add(ref);
		const target = findById(root, ref);
		if (target && target !== glyph && !findById(glyph, ref)) {
			defs.add(clone(target));
			pending.push(...referencedIds(target));
		}
	}
	const styles = root.allElements().filter(i => i.name === 'style').map(clone);
	const body = glyph === root ? new xml.Element('g', {id: `glyph${id}`}, root.allElements().filter(i => i.name !== 'defs' && i.name !== 'style').map(clone)) : clone(glyph);
	return new xml.Element('svg', attributes, [...styles, ...(defs.children.length ? [defs] : []), body]);
}

export function fillSVGviewBox(svg: xml.Element) {
	if (!svg.attributes.viewBox) {
		const body		= svg.children.at(-1)! as xml.Element;
		const extent	= new float2.extent;
		const paths		= (e: xml.Element): void => e.allElements().forEach(i => i.name === 'path' ? extent.combine(curveExtent(parseSVGpath(i.attributes.d))) : paths(i));
		paths(body);
		if (isFinite(extent.min.x))
			svg.attributes.viewBox = `${extent.min.x} ${extent.min.y} ${extent.extent().x} ${extent.extent().y}`;
	}
}

function clone(e: xml.Element): xml.Element {
	return new xml.Element(e.name, {...e.attributes}, e.children.map(i => typeof i === 'object' && 'name' in i ? clone(i) : i));
}

/** An edited document of one glyph put back into the document it came from, as text: the glyph's element replaced, and the
 *  definitions it brought added or changed. A definition that other glyphs use and that was changed is added as another,
 *  with the definitions that use it. */
export function mergeGlyphSVG(text: string, id: number, edited: string) {
	const root	= xml.parse(text).firstElement();
	const glyph = root && findById(root, `glyph${id}`);
	const next	= xml.parse(edited).firstElement();
	const body	= next?.allElements().find(i => i.name !== 'defs' && i.name !== 'style' && i.attributes.id === `glyph${id}`) ?? next?.allElements().find(i => i.name !== 'defs' && i.name !== 'style');
	if (!root || !glyph || !next || !body)
		throw new Error(`the document has no glyph ${id}`);

	// what the rest of the document refers to: a definition in this set is shared
	const shared	= new Set<string>();
	const outside	= (e: xml.Element) => {
		if (e !== glyph) {
			referencedIds(new xml.Element(e.name, e.attributes), shared);
			e.allElements().forEach(outside);
		}
	};
	if (glyph !== root)
		outside(root);

	const defs = () => root.allElements().find(i => i.name === 'defs') ?? (() => {
		const d = new xml.Element('defs');
		root.children.unshift(d);
		d.parent = root;
		return d;
	})();

	// the definitions to be added as other ones: those that are shared and changed, or that use one that is
	const brought	= next.allElements().filter(i => i.name === 'defs').flatMap(i => i.allElements()).filter(i => i.attributes.id);
	const forks		= new Map<string, string>();
	for (let more = true; more;) {
		more = false;
		for (const def of brought) {
			const name = def.attributes.id, old = findById(root, name);
			if (!forks.has(name) && old && shared.has(name) && (old.toString(compact) !== def.toString(compact) || [...referencedIds(def)].some(r => forks.has(r)))) {
				let n = 1;
				while (findById(root, `${name}-${n}`) || [...forks.values()].includes(`${name}-${n}`))
					n++;
				forks.set(name, `${name}-${n}`);
				more = true;
			}
		}
	}

	for (const [from, to] of forks)
		for (const e of [body, ...brought])
			retarget(e, from, to);

	for (const def of brought) {
		const name = def.attributes.id, old = findById(root, name);
		if (forks.has(name)) {
			def.attributes.id = forks.get(name);
			defs().add(def);
		} else if (!old) {
			defs().add(def);
		} else if (old.toString(compact) !== def.toString(compact)) {
			old.attributes	= def.attributes;
			old.children	= def.children;
			def.allElements().forEach(i => { i.parent = old; });
		}
	}

	if (glyph === root) {
		// the document is the glyph: what it keeps besides the drawing is its definitions and styles
		root.children		= [...root.allElements().filter(i => i.name === 'defs' || i.name === 'style'), ...body.children];
	} else {
		glyph.attributes	= {...body.attributes, id: glyph.attributes.id};
		glyph.children		= body.children;
	}
	body.allElements().forEach(i => { i.parent = glyph; });
	return root.toString(compact);
}

//-----------------------------------------------------------------------------
//	SVG documents
//-----------------------------------------------------------------------------

/** One drawn shape: its outline as curves (arcs already cubics), in the document's user units with the y axis
 *  down, every transform from the root to it applied. */
export interface SVGShape extends Layer {
	ids:		string[];		// the ids of the elements it is in, itself last
	layer?:		string;			// the Inkscape layer it is in
}

export interface SVGDocument {
	shapes:		SVGShape[];
	viewBox?:	{x: number, y: number, width: number, height: number};
	width?:		string;			// as written, with its unit
	height?:	string;
	warnings:	string[];		// what the document has that is not read: text, strokes, gradients...
}


// the matrix a transform attribute amounts to: matrix(a b c d e f) takes (x, y) to (ax + cy + e, bx + dy + f)
function transformOf(text: string | undefined): float2x3 {
	let m = float2x3.identity();
	for (const [, name, args] of (text ?? '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
		const a = numbers(args);
		let t: float2x3 | undefined;
		switch (name) {
			case 'matrix':
				if (a.length >= 6)
					t = float2x3(float2(a[0], a[1]), float2(a[2], a[3]), float2(a[4], a[5]));
				break;
			case 'translate':
				t = float2x3(float2(1, 0), float2(0, 1), float2(a[0] ?? 0, a[1] ?? 0));
				break;
			case 'scale':
				t = float2x3(float2(a[0] ?? 1, 0), float2(0, a[1] ?? a[0] ?? 1), float2(0, 0));
				break;
			case 'rotate': {
				const r = (a[0] ?? 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), cx = a[1] ?? 0, cy = a[2] ?? 0;
				t = float2x3(float2(c, s), float2(-s, c), float2(cx - c * cx + s * cy, cy - s * cx - c * cy));
				break;
			}
			case 'skewX':
				t = float2x3(float2(1, 0), float2(Math.tan((a[0] ?? 0) * Math.PI / 180), 1), float2(0, 0));
				break;
			case 'skewY':
				t = float2x3(float2(1, Math.tan((a[0] ?? 0) * Math.PI / 180)), float2(0, 1), float2(0, 0));
				break;
		}
		if (t)
			m = m.mulAffine(t);
	}
	return m;
}

// the properties that shape a drawing, from attributes or a style attribute
function property(e: xml.Element, name: string): string | undefined {
	const style = e.attributes.style;
	if (typeof style === 'string')
		for (const declaration of style.split(';')) {
			const [key, value] = declaration.split(':');
			if (key?.trim() === name && value !== undefined)
				return value.trim();
		}
	const v = e.attributes[name];
	return typeof v === 'string' ? v.trim() : undefined;
}

const SKIPPED = new Set(['defs', 'clipPath', 'mask', 'pattern', 'marker', 'style', 'metadata', 'title', 'desc', 'linearGradient', 'radialGradient', 'filter', 'symbol', 'script', 'foreignObject', 'namedview', 'sodipodi:namedview']);

/** The shapes of an SVG document as curves: paths, rects, circles, ellipses, polygons and polylines, with the
 *  transforms down to them applied and `use` followed. Text and strokes are not drawn, and reported. */
export function parseSVG(text: string): SVGDocument {
	const doc		= xml.parse(text);
	const root		= doc.allElements().find(e => e.name === 'svg') ?? doc.firstElement();
	const result: SVGDocument = {shapes: [], warnings: []};
	if (!root)
		return result;

	const vb = numbers(root.attributes.viewBox);
	if (vb.length === 4)
		result.viewBox = {x: vb[0], y: vb[1], width: vb[2], height: vb[3]};
	result.width	= root.attributes.width;
	result.height	= root.attributes.height;

	const byId = new Map<string, xml.Element>();
	const index = (e: xml.Element) => {
		if (typeof e.attributes.id === 'string')
			byId.set(e.attributes.id, e);
		e.allElements().forEach(index);
	};
	index(root);

	const warned = new Set<string>();
	const warn = (m: string) => {
		if (!warned.has(m)) {
			warned.add(m);
			result.warnings.push(m);
		}
	};

	const visit = (e: xml.Element, m: float2x3, fill: string, ids: string[], layer: string | undefined, depth: number) => {
		if (SKIPPED.has(e.name) || depth > 32 || property(e, 'display') === 'none')
			return;

		m		= m.mulAffine(transformOf(e.attributes.transform));
		fill	= property(e, 'fill') ?? fill;
		if (typeof e.attributes.id === 'string')
			ids = [...ids, e.attributes.id];
		if (e.attributes['inkscape:groupmode'] === 'layer' && typeof e.attributes['inkscape:label'] === 'string')
			layer = e.attributes['inkscape:label'];

		const out: curveVertex[] = [];
		switch (e.name) {
			case 'path': case 'rect': case 'circle': case 'ellipse': case 'polygon': case 'polyline':
				makeCurve(parseSVGshape(e)!, out);
				break;
			case 'line':
				return;		// a line has no inside, and strokes are not drawn
			case 'text':
			case 'tspan':
				warn('text, which is not drawn');
				return;
			case 'use': {
				const href	= e.attributes['xlink:href'] ?? e.attributes.href;
				const target = typeof href === 'string' ? byId.get(href.replace(/^#/, '')) : undefined;
				if (target)
					visit(target, m.mulAffine(float2x3(float2(1, 0), float2(0, 1), float2(length(e.attributes.x), length(e.attributes.y)))), fill, ids, layer, depth + 1);
				return;
			}
			default:
				for (const child of e.allElements())
					visit(child, m, fill, ids, layer, depth + 1);
				return;
		}

		if (/^url\(/.test(fill))
			warn('a gradient or pattern fill, which is drawn as a solid');
		if (fill === 'none') {
			warn('a shape with no fill, which has nothing to draw (strokes are not drawn)');
			return;
		}
		// arcs become cubics here, where they are still circular, so that any transform leaves them exact
		const curve = transformCurve(bezier3Curve(out, 1e-6), m);
		if (curve.length > 1)
			result.shapes.push({curve: curve, fill: {type: FILL.SOLID, color: {r: 0, g: 0, b: 0, a: 1}}, ids, layer});
	};

	visit(root, float2x3.identity(), 'black', [], undefined, 0);
	return result;
}
