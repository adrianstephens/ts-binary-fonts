import { float2, reflect, float2x2, float2x3, max_circle_point, mid, lerp }  from '@isopodlabs/maths/vector';
import { circle, bezier3, line2, bezier2, bezierSpline2, bezierSpline3, bezier2DistanceSq, bezier2Crossings } from '@isopodlabs/maths/geometry';

export interface color {
	r: number,
	g: number,
	b: number,
	a: number,
}

//-----------------------------------------------------------------------------
//	curves
//-----------------------------------------------------------------------------

export const ON_BEGIN	= 0;
export const ON_CURVE	= 1;
export const OFF_BEZ2	= 2;
export const OFF_BEZ3	= 3;
export const OFF_ARC	= 8;
export const ON_ARC		= 9;

export interface curveVertex<T extends number = number> {
	x: number, y: number, flags: T;
}

export type bezier2Curve = curveVertex<typeof ON_BEGIN | typeof ON_CURVE| typeof OFF_BEZ2>[];
export type bezier3Curve = curveVertex<typeof ON_BEGIN | typeof ON_CURVE| typeof OFF_BEZ2 | typeof OFF_BEZ3>[];

export function curveVertex<T extends number>(x: number, y: number, flags: T) : curveVertex<T> {
	return {x, y, flags};
}
export function makeCurveVertex<T extends number>(pt: float2, flags: T) {
	return {x: pt.x, y:pt.y, flags};
}

function pos(v: curveVertex<any>) { return float2(v.x, v.y); }

export function reverseCurve(curve: curveVertex[]) {
	for (let i = 0, e = curve.length; i != e;) {
		let	z = ++i;
		while (z != e && curve[z].flags != ON_BEGIN)
			++z;

		for (let j = z; i < --j; i++)
			[curve[i], curve[j]] = [curve[j], curve[i]];
		i = z;
	}
}

export function direction(curve: curveVertex[]) {
	if (curve.length < 3)
		return false;

	let	miny	= Infinity;
	let	mini	= -1;
	let	min0	= -1;
	let	min1	= -1;
	let	loop	= -1;

	for (let i = 0; i < curve.length; ++i) {
		if (curve[i].flags == ON_BEGIN) {
			if (min0 == loop)
				min1 = i;
			loop	= i;
		}
		if (curve[i].y < miny) {
			miny	= curve[i].y;
			mini	= i;
			min0	= loop;
		}
	}

	if (min0 == loop)
		min1 = curve.length;

	if (mini == min0) {
		for (let i = min1; curve[i - 1].y == miny;)
			mini = --i;
	}
	const next	= pos(curve[mini + 1 == curve.length || mini + 1 == min1 ? min0 : mini + 1]);
	const prev	= pos(curve[(mini == 0 || mini == min0 ? min1 : mini) - 1]);

	return next.sub(pos(curve[mini])).cross(pos(curve[mini]).sub(prev)) < 0;
}

export function mapCurve<T extends number>(curve: curveVertex<T>[] | undefined, apply: (v: float2) => float2) {
	return curve ? curve.map(i => makeCurveVertex(apply(pos(i)), i.flags)) : [];
}
export function transformCurve<T extends number>(curve: curveVertex<T>[] | undefined, transform: float2x3) {
	return mapCurve(curve, p => transform.mulPos(p));
}

//	translate between points-on-curve format and radii/angle format
class ArcParams {
	constructor(public radii: float2, public angle: number, public clockwise: boolean, public big: boolean) {}

	static make2off(p0: float2, p1: float2, p2: float2, p3: float2) {	// 2 off-curve
		const	m0	= float2x2(p3.sub(p0), p1.sub(p0));		//chord, incoming direction
		const	d1t	= m0.inverse().mul(p2.sub(p3));		//outgoing direction
		const	s	= -d1t.x / (2 * d1t.y);						//shear to make d1, d2 reflections of each other
		const	r	= Math.sqrt(1 + s * s) / 2;					//radius
		const	mi	= m0.matmul(float2x2(float2(1, 0), float2(-s, 1)));
		const	sc	= max_circle_point(mi as float2x2);
	
		const	axis1	= mi.mul(sc);
		const	axis2	= mi.mul(sc.perp());
		return new ArcParams(float2(axis1.len() * r, axis2.len() * r), Math.atan2(axis1.y, axis1.x), m0.det() < 0, s < 0);
	}
	static make1off(p0: float2, p1: float2, p2: float2) {				// 1 off-curve
		const	y	= p2.sub(p0);	//chord
		const	d	= p1.sub(p0);	//incoming direction
		const	x	= y.cross(d);
	
		const	radius	= y.dot(y) / (Math.abs(x) / d.len() * 2);
		return new ArcParams(float2(radius, radius), 0, x < 0, y.dot(d) < 0);
	}

	matrix()	{
		return float2.rotate(this.angle).matmul(float2.scale(float2(this.radii.x, this.radii.y)));
	}
	fix_radii(p0: float2, p1: float2) {
		const	d1	= this.matrix().inverse().mul(p1.sub(p0).scale(0.5));
		const	d2	= d1.len();
		if (d2 > 1) {
			this.radii.x *= d2;
			this.radii.y *= d2;
		}
	}
	ellipse(p0: float2, p1: float2) {
		let		m	= this.matrix();
		const	d1	= m.inverse().mul(p1.sub(p0).scale(0.5));
		const	d2	= d1.lensq();
		const	middle	= mid(p0, p1);
	
		if (d2 > 1) {
			m = float2.scale(Math.sqrt(d2)).matmul(m);
			return float2x3(m.x, m.y, middle);
		}
		const	y0	= Math.sqrt(1 - d2);
		const	y	= this.big === this.clockwise ? -y0 : y0;
		return float2x3(m.x, m.y, middle.add(m.mul(d1.scale(y / Math.sqrt(d2)).perp())));
	}
	control_points(p0: float2, p1: float2) {
		const	e	= this.ellipse(p0, p1);
		const	ei	= e.inverse();
		let		c0	= ei.mulPos(p0);
		let		c1	= ei.mulPos(p1);
		if (this.clockwise) {
			c0 = c0.add(c0.perp().scale(2));
			c1 = c1.sub(c1.perp().scale(2));
		} else {
			c0 = c0.sub(c0.perp().scale(2));
			c1 = c1.add(c1.perp().scale(2));
		}
		return [e.mulPos(c0), e.mulPos(c1)];
	}
};

export interface CurveSink {
	Begin(a: float2):void;
	End():void;
	Line(a: float2, b: float2): void;
	Bezier2(a: float2, b: float2, c: float2): void;
	Bezier3(a: float2, b: float2, c: float2, d: float2): void;
	Arc(a: float2, b: float2, c: float2, d: float2): void;
	Arc3(a: float2, b: float2, c: float2): void;
}

export interface CurveSource {
	run(sink: Partial<CurveSink>):void;
}
/*
function MakeCurve(source: CurveSource) {
	const out: curveVertex[] = [];

	const sink: CurveSink = {
		Begin(a: float2) {
			out.push(makeCurveVertex(a, CURVE.ON_BEGIN));
		},
		End() {},
		Line(a: float2, b: float2) {
			out.push(makeCurveVertex(a, CURVE.ON_CURVE));
		},
		Bezier2(a: float2, b: float2, c: float2) {
			out.push(makeCurveVertex(b, CURVE.OFF_BEZ2));
			out.push(makeCurveVertex(c, CURVE.ON_CURVE));
		},
		Bezier3(a: float2, b: float2, c: float2, d: float2) {
			out.push(makeCurveVertex(b, CURVE.OFF_BEZ3));
			out.push(makeCurveVertex(c, CURVE.OFF_BEZ3));
			out.push(makeCurveVertex(d, CURVE.ON_CURVE));
		},
		Arc(a: float2, b: float2, c: float2, d: float2) {
			out.push(makeCurveVertex(b, CURVE.OFF_ARC));
			out.push(makeCurveVertex(c, CURVE.OFF_ARC));
			out.push(makeCurveVertex(d, CURVE.ON_ARC));
		},
		Arc3(a: float2, b: float2, c: float2) {
			out.push(makeCurveVertex(b, CURVE.OFF_ARC));
			out.push(makeCurveVertex(c, CURVE.ON_ARC));
		}
	};
	source.run(sink);
	return out;
}
*/
export function parseCurve(curves: curveVertex[]): CurveSource {
	let start			= float2(0, 0);
	let prev			= float2(0, 0);
	let prev2			= float2(0, 0);
	let prev3			= float2(0, 0);
	let prev_flags		= ON_BEGIN;
	let prev2_flags 	= ON_BEGIN;

	function on_curve(t: CurveSink, pt: float2) {
		switch (prev_flags) {
			case ON_BEGIN:
			case ON_CURVE:
			case ON_ARC:	t.Line(prev, pt); break;
			case OFF_BEZ2:	t.Bezier2(prev2, prev, pt); break;
			case OFF_BEZ3:	t.Bezier3(prev3, prev2, prev, pt); break;
			case OFF_ARC:
				if (prev2_flags == OFF_ARC) {
					// 2 off-curve
					t.Arc(prev3, prev2, prev, pt);
					if (pt.sub(prev3).cross(pt.sub(prev2)) < 0)
						prev	= pt.add(pt.sub(prev));

				} else {
					// 1 off-curve
					t.Arc3(prev2, prev, pt);
					prev	= pt.sub(reflect(prev.sub(prev2), pt.sub(prev2)));
				}
				break;
		}
	}

	return {
		run(sink0) {
			const sink: CurveSink = {
				Begin() 	{},
				End() 		{},
				Line() 		{},
				Bezier2()	{},
				Bezier3()	{},
				Arc() 		{},
				Arc3() 		{},
				...sink0
			};
			for (const i of curves) {
				let flags	= i.flags;
				let pt		= float2(i.x, i.y);
				switch (flags) {
					case ON_BEGIN:
						if (prev_flags) {
							on_curve(sink, start);
							sink.End();
						}
						sink.Begin(pt);
						start	= pt;
						break;
		
					case ON_CURVE:
						on_curve(sink, pt);
						break;
		
					case OFF_BEZ2:
						if (prev_flags > 1) {
							// two off-curve points in a row: TrueType implies an on-curve point at their midpoint,
							// ending the curve so far there. The loop's own bottom-of-loop bookkeeping below sets
							// prev2 = prev unconditionally, so without this reassignment the *next* Bezier2 would
							// start from the earlier control point again instead of from this implied point,
							// skipping over it and drawing a shape that never actually passes through it.
							const implied = mid(prev, pt);
							on_curve(sink, implied);
							prev = implied;
						}
						break;
		
					case OFF_BEZ3:
						if (prev_flags == 8) {
							on_curve(sink, pt);
							[pt, prev] = [prev, pt];
		
						} else if (prev_flags > 2 && prev2_flags > 1) {
							on_curve(sink, mid(prev, pt));
							prev	= mid(prev, pt);
							flags	= OFF_BEZ2;
						}
						break;
		
					case OFF_ARC:
						break;
		
					case ON_ARC:
						sink.Arc3(prev, prev.add(prev.sub(prev2)), pt);
						break;
				}
		
				prev3		= prev2;
				prev2_flags	= prev_flags;
				prev2		= prev;
				prev_flags	= flags;
				prev		= pt;

			}

			if (prev_flags) {
				on_curve(sink, start);
				sink.End();
				prev_flags = ON_BEGIN;
			}
		}
	};
}

export function curveExtent(source: CurveSource) {
	const ext = new float2.extent;
	source.run({
		Begin(a) 				{ ext.add(a); },
		Line(_a, b) 			{ ext.add(b); },
		Bezier2(_a, b, c) 		{ ext.add(b); ext.add(c); },
		Bezier3(_a, b, c, d)	{ ext.add(b); ext.add(c); ext.add(d); },
		Arc(_a, b, c, d) 		{ ext.add(b); ext.add(c); ext.add(d); },
		Arc3(_a, b, c) 			{ ext.add(b); ext.add(c); }
	});
	return ext;
}


//-----------------------------------------------------------------------------
//	approximate curves
//-----------------------------------------------------------------------------

// an arc as cubics, at most a quarter turn each: the arc is a circular arc in the space of its ellipse, which the
// ellipse's affine map carries (along with any bezier's control points) straight into place
function arcToCubics(params: ArcParams, p0: float2, p1: float2): bezierSpline3<float2> {
	const	e		= params.ellipse(p0, p1);
	const	ei		= e.inverse();
	const	c0		= ei.mulPos(p0), c1 = ei.mulPos(p1);
	const	theta0	= Math.atan2(c0.y, c0.x);
	let		sweep	= Math.atan2(c1.y, c1.x) - theta0;
	if (params.clockwise) {			// travels in the direction of perp(c0), ie increasing angle
		if (sweep <= 0)
			sweep += 2 * Math.PI;
	} else if (sweep >= 0) {
		sweep -= 2 * Math.PI;
	}

	const	n		= Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
	const	step	= sweep / n;
	const	k		= 4 / 3 * Math.tan(step / 4);

	return new bezierSpline3([p0,
		...Array.from({length: n}, (_, i) => {
		const	a	= float2.cossin(theta0 + i * step);
		const	d	= float2.cossin(theta0 + (i + 1) * step);
		return [
			e.mulPos(a.add(a.perp().scale(k))),
			e.mulPos(d.sub(d.perp().scale(k))),
			i == n - 1	? p1 : e.mulPos(d)
		];
	}).flat()]);
}


// replace arc segments by cubics within tol of them; a curve with none is returned as is
export function bezier3Curve(curve: curveVertex[], tol: number) {
	if (curve.every(v => v.flags <= OFF_BEZ3))
		return curve as bezier3Curve;

	if (tol <= 0)
		tol = 1e-6;

	const	out: bezier3Curve = [];
	let		begin: float2;
	// parseCurve closes a contour with a segment ending at the begin point itself, which the format leaves implicit
	const	on	= (p: float2) => p !== begin && out.push(makeCurveVertex(p, ON_CURVE));
	const	off	= (p: float2) => out.push(makeCurveVertex(p, OFF_BEZ2));

	function cubic(_a: float2, b: float2, c: float2, d: float2) {
		out.push(makeCurveVertex(c, OFF_BEZ3));
		out.push(makeCurveVertex(c, OFF_BEZ3));
		on(d);
	}

	function arc(params: ArcParams, a: float2, d: float2) {
		for (const c of arcToCubics(params, a, d))
			cubic(c.c0, c.c1, c.c2, c.c3);
	}

	parseCurve(curve).run({
		Begin(a)			{ out.push(makeCurveVertex(begin = a, ON_BEGIN)); },
		Line(_a, b)			{ on(b); },
		Bezier2(_a, b, c)	{ off(b); on(c); },
		Bezier3(a, b, c, d)	{ cubic(a, b, c, d); },
		Arc(a, b, c, d)		{ arc(ArcParams.make2off(a, b, c, d), a, d); },
		Arc3(a, b, c)		{ arc(ArcParams.make1off(a, b, c), a, c); },
	});
	return out;
}


function cubic_within(b3: bezier3<float2>, tol: number): boolean {
	if (b3.c1.len() <= tol && b3.c2.len() <= tol)
		return true;
	const	[s0, s1] = b3.split();
	return s0.c3.len() <= tol && cubic_within(s0, tol) && cubic_within(s1, tol);
}

function quadratic_fits(b3: bezier3<float2>, b2: bezier2<float2>, tol: number) {
	const	d0	= b2.c0.sub(b3.c0), d3 = b2.c2.sub(b3.c3);
	return d0.len() <= tol && d3.len() <= tol
		&& cubic_within(new bezier3(d0, lerp(b2.c0, b2.c1, 2 / 3).sub(b3.c1), lerp(b2.c2, b2.c1, 2 / 3).sub(b3.c2), d3), tol);
}

// replace cubic and arc segments by quadratics within tol of them; a curve with none is returned as is
export function bezier2Curve(curve: curveVertex[], tol: number) {
	if (curve.every(v => v.flags <= OFF_BEZ2))
		return curve as bezier2Curve;

	if (tol <= 0)
		tol = 1e-6;

	const	out: bezier2Curve = [];
	let		begin: float2;
	// parseCurve closes a contour with a segment ending at the begin point itself, which the format leaves implicit
	const	on	= (p: float2) => p !== begin && out.push(makeCurveVertex(p, ON_CURVE));
	const	off	= (p: float2) => out.push(makeCurveVertex(p, OFF_BEZ2));

	function cubic(a: float2, b: float2, c: float2, d: float2) {
		const bez3	= new bezier3(a, b, c, d);
		const bez2	= new bezier2(a, new line2(a, b).intersection(new line2(d, c)), d);
		if (quadratic_fits(bez3, bez2, tol)) {
			off(bez2.c1);
		} else {
			for (let n = 2; ; n++) {
				const	pieces	= Array.from({length: n}, (_, i) => bez3.slice(i / n, (i + 1) / n));
				const	q		= pieces.map((p, i) => lerp(lerp(p.c0, p.c1, 1.5), lerp(p.c3, p.c2, 1.5), i / (n - 1)));
				const 	qs 		= new bezierSpline2([
					pieces[0].c0,
					...Array.from({length: n - 1}, (_, i) => [q[i], mid(q[i], q[i + 1])]).flat(),
					q[n - 1],
					pieces[n - 1].c3
				]);
				if (pieces.every((p, i) => quadratic_fits(p, qs.get(i), tol))) {
					pieces.forEach((_, i) => off(qs.get(i).c1));
					break;
				}
			}
		}
		on(d);
	}

	function arc(params: ArcParams, a: float2, d: float2) {
		for (const c of arcToCubics(params, a, d))
			cubic(c.c0, c.c1, c.c2, c.c3);
	}

	parseCurve(curve).run({
		Begin(a)			{ out.push(makeCurveVertex(begin = a, ON_BEGIN)); },
		Line(_a, b)			{ on(b); },
		Bezier2(_a, b, c)	{ off(b); on(c); },
		Bezier3(a, b, c, d)	{ cubic(a, b, c, d); },
		Arc(a, b, c, d)		{ arc(ArcParams.make2off(a, b, c, d), a, d); },
		Arc3(a, b, c)		{ arc(ArcParams.make1off(a, b, c), a, c); },
	});
	return out;
}

export function curvepathDistance2(p: float2, curve: bezier2Curve): number {
	let d2 = Infinity, crossings = 0;

	parseCurve(curve).run({
		Line(a, b) {
			const line = new line2(a, b);
			d2 = Math.min(d2, line.distanceSq(p));
			if (line.crossesRay(p))
				++crossings;
		},
		Bezier2(a, b, c) {
			const bez = new bezier2(a, b, c);
			d2 = Math.min(d2, bezier2DistanceSq(p, bez));
			crossings += bezier2Crossings(p, bez);
		},
	});

	return (crossings & 1 ? -1 : 1) * Math.sqrt(d2);
}

//-----------------------------------------------------------------------------
//	Fill
//-----------------------------------------------------------------------------

export const FILL = {
	SOLID:		0,
	LINEAR:		1,
	SWEEP:		2,
	RADIAL: 	3,
} as const;

export const EXTEND = {
	PAD:		0,	 // Use nearest color stop
	REPEAT: 	1,	 // Repeat from farthest color stop
	REFLECT:	2,	 // Mirror color line from nearest end
} as const;
export type EXTEND = typeof EXTEND[keyof typeof EXTEND];

export interface ColorStop {
	color:	color,
	stop:	number;
}

export interface Gradient {
	stops:		ColorStop[];
	extend:		EXTEND;
	transform:	float2x3;
}

export type Fill =
	{type: typeof FILL.SOLID,	color: color}
|	{type: typeof FILL.LINEAR,	p0: float2, p1: float2, p2: float2, gradient: Gradient}
|	{type: typeof FILL.SWEEP,	p0: float2, angle0: number, angle1: number, gradient: Gradient}
|	{type: typeof FILL.RADIAL,	c0: circle, c1: circle, gradient: Gradient}


export interface Layer {
	curves:		curveVertex[];
	fill:		Fill;
};

//-----------------------------------------------------------------------------
//	SVG
//-----------------------------------------------------------------------------

export function makeSVGPath(source: CurveSource) {
	const commands: { command: string, params: number[]; }[] = [];

	// the y flip mirrors the arc: the rotation and the sweep direction both reverse
	function arc(ap: ArcParams, end: float2) {
		commands.push({command: 'A', params: [ap.radii.x, ap.radii.y, -ap.angle * 180 / Math.PI, ap.big ? 1 : 0, ap.clockwise ? 0 : 1, end.x, -end.y]});
	}
	
	source.run({
		Begin(a) 				{ commands.push({command: 'M', params: [a.x, -a.y]}); },
		Line(_a, b)	 			{ commands.push({command: 'L', params: [b.x, -b.y]}); },
		Bezier2(_a, b, c)		{ commands.push({command: 'Q', params: [b.x, -b.y, c.x, -c.y]}); },
		Bezier3(_a, b, c, d)	{ commands.push({command: 'C', params: [b.x, -b.y, c.x, -c.y, d.x, -d.y]}); },
		Arc3(a, b, c)			{ arc(ArcParams.make1off(a, b, c), c); },
		Arc(a, b, c, d)			{ arc(ArcParams.make2off(a, b, c, d), d); },
	});
	return commands.map(c => c.command + c.params.map(i => i.toString()).join(',')).join('');
}

// SVG path data. Coordinates are used as written (makeSVGPath's y flip is not undone). Subpaths are closed implicitly,
// as parseCurve closes them, and a drawing command after Z starts a new subpath where the last one began.
export function parseSVGpath(path: string): CurveSource {
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

			const close = () => {
				if (open) {
					if (cur.x !== start.x || cur.y !== start.y)
						sink.Line(cur, start);
					sink.End();
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
					close();
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
