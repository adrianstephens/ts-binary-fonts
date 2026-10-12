import { float2, reflect, float2x2, float2x3, max_circle_point, mid, lerp, normalise }  from '@isopodlabs/maths/vector';
import { Matrix } from '@isopodlabs/maths/linear';
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
export const ON_END		= 4;	// an on-curve point that ends a contour left open, which is otherwise closed back to its begin point
export const OFF_BEZ2	= 2;
export const OFF_BEZ3	= 3;
export const OFF_ARC	= 8;
export const ON_ARC		= 9;

export interface curveVertex<T extends number = number> {
	x: number, y: number, flags: T;
}

export type bezier2Curve = curveVertex<typeof ON_BEGIN | typeof ON_CURVE | typeof ON_END | typeof OFF_BEZ2>[];
export type bezier3Curve = curveVertex<typeof ON_BEGIN | typeof ON_CURVE | typeof ON_END | typeof OFF_BEZ2 | typeof OFF_BEZ3>[];

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
export class ArcParams {
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
	End(open?: boolean):void;
	Line(a: float2, b: float2): void;
	Bezier2(a: float2, b: float2, c: float2): void;
	Bezier3(a: float2, b: float2, c: float2, d: float2): void;
	Arc(a: float2, b: float2, c: float2, d: float2): void;
	Arc3(a: float2, b: float2, c: float2): void;
}

export interface CurveSource {
	run(sink: Partial<CurveSink>):void;
}

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

					case ON_END:
						on_curve(sink, pt);
						sink.End(true);
						flags = ON_BEGIN;
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

export function curveMaker(out: curveVertex[]): CurveSink {
	let begin = 0;
	return {
		Begin(a)			{ begin = out.length; out.push(makeCurveVertex(a, ON_BEGIN)); },
		// a contour of one point has nothing to draw, a closed one does not repeat its begin point, and an open one ends with ON_END
		End(open)			{
			const last = out[out.length - 1], first = out[begin];
			if (out.length - begin < 2)
				out.length = begin;
			else if (open)
				last.flags = ON_END;
			else if (out.length - begin > 2 && last.flags === ON_CURVE && last.x === first.x && last.y === first.y)
				out.pop();
		},
		Line(_a, b)			{ out.push(makeCurveVertex(b, ON_CURVE)); },
		Bezier2(_a, b, c)	{ out.push(makeCurveVertex(b, OFF_BEZ2), makeCurveVertex(c, ON_CURVE)); },
		Bezier3(_a, b, c, d){ out.push(makeCurveVertex(b, OFF_BEZ3), makeCurveVertex(c, OFF_BEZ3), makeCurveVertex(d, ON_CURVE)); },
		Arc(_a, b, c, d)	{ out.push(makeCurveVertex(b, OFF_ARC), makeCurveVertex(c, OFF_ARC), makeCurveVertex(d, ON_CURVE)); },
		Arc3(_a, b, c)		{ out.push(makeCurveVertex(b, OFF_ARC), makeCurveVertex(c, ON_CURVE)); },
	};
}

export function putRect(p0: float2, p1: float2) : CurveSource {
	return {
		run(sink: Partial<CurveSink>) {
			sink.Begin?.(p0);
			sink.Line?.(p0, float2(p1.x, p0.y));
			sink.Line?.(float2(p1.x, p0.y), p1);
			sink.Line?.(p1, float2(p0.x, p1.y));
			sink.End?.();
		}
	};
}
export function putRoundedRect(p0: float2, p1: float2, r: float2) : CurveSource {
	return {
		run(sink: Partial<CurveSink>) {
			let a: float2;
			const move = (to: float2) => { sink.Begin?.(to); a = to; };
			const line = (to: float2) => { sink.Line?.(a!, to); a = to; };
			const hline = (s: number) => line(float2(s, a!.y));
			const vline = (s: number) => line(float2(a!.x, s));

			const	ap = new ArcParams(r, 0, true, false);
			const arc = (to: float2) => {
				const	cp = ap.control_points(a, to);
				sink.Arc?.(a, cp[0], cp[1], to);
				a = to;
			};

			move(float2(p0.x + r.x, p0.y));
			hline(p1.x - r.x);
			arc(float2(p1.x, p0.y + r.y));
			vline(p1.y - r.y);
			arc(float2(p1.x - r.x, p1.y));
			hline(p0.x + r.x);
			arc(float2(p0.x, p1.y - r.y));
			vline(p0.y + r.y);
			arc(float2(p0.x + r.x, p0.y));
			sink.End?.();
		}
	};
}
export function putEllipse(c: float2, r: float2) {
	return {
		run(sink: Partial<CurveSink>) {
			let a: float2;
			const move = (to: float2) => { sink.Begin?.(to); a = to; };
			const ap = new ArcParams(r, 0, false, true);
			const arc = (to: float2) => {
				const	cp = ap.control_points(a, to);
				sink.Arc?.(a, cp[0], cp[1], to);
				a = to;
			};
			move(float2(c.x + r.x, c.y));
			arc(float2(c.x - r.x, c.y));
			arc(float2(c.x + r.x, c.y));
			sink.End?.();
		}
	};
}

export function putPolygon(p: float2[], close: boolean) {
	return {
		run(sink: Partial<CurveSink>) {
			let a: float2;
			const move = (to: float2) => { sink.Begin?.(to); a = to; };
			const line = (to: float2) => { sink.Line?.(a!, to); a = to; };

			move(p[0]);
			p.slice(1).forEach(line);
			sink.End?.(!close);
		}
	};
}


/** Path data (or any CurveSource) as curve vertices, with an arc's two control points as arc vertices. */
export function makeCurve(source: CurveSource, out = [] as curveVertex[]): curveVertex[] {
	source.run(curveMaker(out));
	return out;
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

export function curveExtentQuick(source: curveVertex[]) {
	return float2.extent.from(source.map(pos));
}

//-----------------------------------------------------------------------------
//	approximate curves
//-----------------------------------------------------------------------------

// an on-curve point halfway between two quadratic controls is implied by them, so it is not needed
function stripImpliedPoints(curve: curveVertex[]) {
	return curve.filter((v, i) => {
		const	a = curve[i - 1], b = curve[i + 1];
		return !(v.flags === ON_CURVE && a?.flags === OFF_BEZ2 && b?.flags === OFF_BEZ2 && mid(pos(a), pos(b)).sub(pos(v)).len() < 1e-9 * (1 + Math.abs(v.x) + Math.abs(v.y)));
	});
}


// an arc as cubics, at most a quarter turn each: the arc is a circular arc in the space of its ellipse, which the
// ellipse's affine map carries (along with any bezier's control points) straight into place
export function arcToCubics(params: ArcParams, p0: float2, p1: float2): bezierSpline3<float2> {
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
		out.push(makeCurveVertex(b, OFF_BEZ3));
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
		End(open)			{ if (open) out[out.length - 1].flags = ON_END; },
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
		End(open)			{ if (open) out[out.length - 1].flags = ON_END; },
	});
	return out;
}

//-----------------------------------------------------------------------------
//	simplify curves
//-----------------------------------------------------------------------------

type Emit = (sink: CurveSink) => void;
interface Segment {
	bez:	bezier3<float2>;	// the segment as a cubic, for fitting
	emit:	Emit;				// the segment as it was
}

const CORNER	= Math.cos(Math.PI / 6);	// a sharper turn than this is kept as a corner, a gentler one may be merged across

function segmentDir(b: bezier3<float2>, end: boolean) {
	const	[p, ...q] = end ? [b.c3, b.c2, b.c1, b.c0] : [b.c0, b.c1, b.c2, b.c3];
	return normalise(q.map(i => end ? p.sub(i) : i.sub(p)).find(d => d.lensq() > 0) ?? float2(1, 0));
}

// a curve fitted to points: where it is, its first and second derivatives, and how it is written
interface Fitted {
	evaluate(t: number): float2;
	tangent(t: number): float2;
	accel(t: number): float2;
	emit: Emit;
}

// the quadratics through on-curve points c[0], c[2]... with the control points c[1], c[3]... between them, each taking an equal share of the parameter
function quadChain(c: float2[]): Fitted {
	const	spline	= new bezierSpline2(c), n = spline.length;
	// the spline's own evaluate indexes past its last segment at t = 1
	const	at		= (t: number) => {
		const	k = Math.min(n - 1, Math.floor(t * n));
		return {b: spline.get(k), s: t * n - k};
	};
	return {
		evaluate(t)	{ const {b, s} = at(t); return b.evaluate(s); },
		tangent(t)	{ const {b, s} = at(t); return b.tangent(s).scale(n); },
		accel(t)	{ const {b} = at(t); return b.c2.sub(b.c1.scale(2)).add(b.c0).scale(2 * n * n); },
		emit: sink => {
			for (const b of spline)
				sink.Bezier2(b.c0, b.c1, b.c2);
		},
	};
}

function cubicFitted(bez: bezier3<float2>): Fitted {
	const	d2 = bez.spline().deriv().deriv(), d2x = d2.map(c => c.x), d2y = d2.map(c => c.y);
	return {
		evaluate:	t => bez.evaluate(t),
		tangent:	t => bez.tangent(t),
		accel:		t => float2(d2x.evaluate(t), d2y.evaluate(t)),
		emit:		sink => sink.Bezier3(bez.c0, bez.c1, bez.c2, bez.c3),
	};
}

// a way to fit a curve to points from p[0] to p[n] leaving along t1 and arriving along -t2
type Maker = (p: float2[], u: number[], t1: float2, t2: float2) => Fitted | undefined;

// handles along the end tangents, their lengths by least squares: the curve is base + h1 * w1(t) + h2 * w2(t) in the weights basis gives, and make builds it from the handle ends
function handleMaker(basis: (t: number) => number[], make: (p0: float2, h1: float2, h2: float2, p3: float2) => Fitted): Maker {
	return (p, u, t1, t2) => {
		const	p0	= p[0], p3 = p[p.length - 1];
		let		c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
		p.forEach((pt, i) => {
			const	[w0, w1, w2, w3] = basis(u[i]);
			const	a1	= t1.scale(w1), a2 = t2.scale(w2);
			const	r	= pt.sub(p0.scale(w0 + w1)).sub(p3.scale(w2 + w3));
			c00	+= a1.dot(a1);
			c01	+= a1.dot(a2);
			c11	+= a2.dot(a2);
			x0	+= a1.dot(r);
			x1	+= a2.dot(r);
		});
		const	det	= c00 * c11 - c01 * c01;
		const	len	= p3.sub(p0).len();
		let		l1	= (x0 * c11 - x1 * c01) / det;
		let		l2	= (c00 * x1 - c01 * x0) / det;
		if (!(l1 > 1e-6 * len && l2 > 1e-6 * len))
			l1 = l2 = len / 3;
		return make(p0, p0.add(t1.scale(l1)), p3.add(t2.scale(l2)), p3);
	};
}

const cubicMaker = handleMaker(
	t => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3],
	(p0, h1, h2, p3) => cubicFitted(new bezier3(p0, h1, h2, p3))
);

// the weights, over p0, the controls q1..qn and p3, of the point at t on the chain of n quadratics through p0, q1, mid(q1, q2), q2 ... qn, p3
function chainWeights(n: number, t: number) {
	const	k = Math.min(n - 1, Math.floor(t * n)), s = t * n - k, v = 1 - s;
	const	w = new Array<number>(n + 2).fill(0);
	// the segment runs from the previous joint through control q(k+1) to the next, a joint being halfway between two controls
	if (k) {
		w[k]		+= v * v / 2;
		w[k + 1]	+= v * v / 2;
	} else {
		w[0]		+= v * v;
	}
	w[k + 1] += 2 * s * v;
	if (k < n - 1) {
		w[k + 1]	+= s * s / 2;
		w[k + 2]	+= s * s / 2;
	} else {
		w[n + 1]	+= s * s;
	}
	return w;
}

// a chain of n quadratics, whose joints are implied by the controls: the first and last controls lie along the end tangents and the rest are free, all by least squares
const chainMaker = (n: number): Maker => (p, u, t1, t2) => {
	const	p0 = p[0], p3 = p[p.length - 1], unknowns = 2 * n - 2;
	if (p.length < 2 * n)
		return;
	const	N = Array.from({length: unknowns}, () => new Array<number>(unknowns).fill(0)), g = new Array<number>(unknowns).fill(0);
	p.forEach((pt, i) => {
		const	w = chainWeights(n, u[i]);
		for (const c of ['x', 'y'] as const) {
			// the point's coordinate is base + the unknowns' coefficients dotted with them: a and b, then the free controls' x and y
			const	row = new Array<number>(unknowns).fill(0);
			const	base = w[0] * p0[c] + w[1] * p0[c] + w[n] * p3[c] + w[n + 1] * p3[c];
			row[0] = w[1] * t1[c];
			row[1] = w[n] * t2[c];
			for (let k = 2; k < n; k++)
				row[2 * k - 2 + (c === 'x' ? 0 : 1)] = w[k];
			for (let r = 0; r < unknowns; r++) {
				g[r] += row[r] * (pt[c] - base);
				for (let k = 0; k < unknowns; k++)
					N[r][k] += row[r] * row[k];
			}
		}
	});
	const	x = Matrix(N).inverse()?.mulVec(g);
	if (!x || !(x[0] > 0 && x[1] > 0))
		return;
	const	q = [p0.add(t1.scale(x[0])), ...Array.from({length: n - 2}, (_, k) => float2(x[2 + 2 * k], x[3 + 2 * k])), p3.add(t2.scale(x[1]))];
	return quadChain([p0, ...q.flatMap((c, k) => k ? [mid(q[k - 1], c), c] : [c]), p3]);
};

// one quadratic, whose control point is where the end tangents meet
const quadMaker: Maker = (p, _u, t1, t2) => {
	const	p0	= p[0], p3 = p[p.length - 1], den = t1.cross(t2);
	const	l1	= p3.sub(p0).cross(t2) / den, l2 = t1.cross(p3.sub(p0)) / den;
	return l1 > 0 && l2 > 0 ? quadChain([p0, p0.add(t1.scale(l1)), p3]) : undefined;
};

function distToSegment(q: float2, a: float2, b: float2) {
	const	ab = b.sub(a);
	return q.sub(a.add(ab.scale(Math.min(1, Math.max(0, q.sub(a).dot(ab) / (ab.lensq() || 1)))))).len();
}

// whether the cubic strays more than tol from the polyline between the points, midway between each pair of them
function bulges(bez: Fitted, p: float2[], u: number[], tol: number) {
	return u.slice(1).some((u1, k) => {
		const	q = bez.evaluate((u[k] + u1) / 2);
		return Math.min(...p.slice(Math.max(0, k - 2), k + 3).slice(1).map((b, i) => distToSegment(q, p[Math.max(0, k - 2) + i], b))) > tol;
	});
}

// a single curve through the points, with the end tangents given, if one is within tol of all of them
function fitCurve(p: float2[], u: number[], t1: float2, t2: float2, tol: number, make: Maker) {
	for (let iter = 0; iter < 5; iter++) {
		const	f = make(p, u, t1, t2);
		if (!f)
			return;
		if (p.every((pt, i) => f.evaluate(u[i]).sub(pt).len() <= tol) && !bulges(f, p, u, tol))
			return f;
		u = u.map((t, i) => {
			const	q	= f.evaluate(t).sub(p[i]), v = f.tangent(t);
			const	den	= v.lensq() + q.dot(f.accel(t));
			return den ? Math.min(1, Math.max(0, t - q.dot(v) / den)) : t;
		});
	}
}

// the line from p[0] to p[n], if it is within tol of all the points
function fitLine(p: float2[], tol: number) {
	const	a	= p[0], d = p[p.length - 1].sub(a), len = d.len();
	return len > 0 && p.every(pt => {
		const	r = pt.sub(a), s = r.dot(d) / len;
		return s >= -tol && s <= len + tol && Math.abs(r.cross(d)) <= tol * len;
	});
}

function isCorner(a: Segment, b: Segment) {
	return segmentDir(a.bez, true).dot(segmentDir(b.bez, false)) < CORNER;
}

// points along a run of smooth segments, with the unit tangent at each and the index of each segment's first; t0 and t1 are the tangents at its two ends
// each segment has enough points that its chords lie within tol/8 of it, and are no longer than 16 tol
function sampleRun(run: Segment[], t0: float2, t1: float2, tol: number) {
	const	p: float2[] = [], t: float2[] = [], starts: number[] = [];
	run.forEach((seg, i) => {
		const	b	= seg.bez;
		const	n	= Math.min(64, Math.max(2, Math.ceil(b.c3.sub(b.c0).len() / (16 * tol)), Math.ceil(Math.sqrt(6 * Math.max(b.c2.sub(b.c1.scale(2)).add(b.c0).len(), b.c3.sub(b.c2.scale(2)).add(b.c1).len()) / tol))));
		starts.push(p.length);
		for (let m = 0; m < n; m++) {
			p.push(b.evaluate(m / n));
			// at a joint between segments the tangent is the mean of the two sides, which suits polylines too
			t.push(m ? normalise(b.tangent(m / n)) : i ? normalise(segmentDir(run[i - 1].bez, true).add(segmentDir(b, false))) : t0);
		}
	});
	starts.push(p.length);
	p.push(run[run.length - 1].bez.c3);
	t.push(t1);
	return {p, t, starts};
}

// the longest pieces of a run that are each a line or cubic within tol, with the breaks free to fall anywhere along it
function simplifyRun(run: Segment[], t0: float2, t1: float2, tol: number, quad: boolean, sink: CurveSink) {
	const	{p, t, starts}	= sampleRun(run, t0, t1, tol);
	const	last	= p.length - 1;

	const	fit = (i: number, j: number): Emit | undefined => {
		const	seg = starts.indexOf(i);
		if (seg >= 0 && starts[seg + 1] == j)
			return run[seg].emit;

		const	q = p.slice(i, j + 1);
		if (fitLine(q, tol))
			return s => s.Line(q[0], q[j - i]);

		let		total = 0;
		const	u = q.map((pt, k) => total += k ? pt.sub(q[k - 1]).len() : 0).map(l => l / total);
		for (const make of quad ? [quadMaker, ...[2, 3, 4, 5, 6, 8].map(chainMaker)] : [cubicMaker]) {
			const	f = fitCurve(q, u, t[i], t[j].scale(-1), tol, make);
			if (f)
				return f.emit;
		}
	};

	for (let i = 0; i < last;) {
		let	good = i + 1, bad = last + 1;
		let	best = fit(i, good);

		// double the piece until a fit fails, then bisect between the last that worked and the first that did not
		while (good < last && bad > last) {
			const	k = Math.min(last, i + 2 * (good - i)), f = fit(i, k);
			if (f) {
				good = k;
				best = f;
			} else {
				bad = k;
			}
		}
		while (bad - good > 1) {
			const	k = (good + bad) >> 1, f = fit(i, k);
			if (f) {
				good = k;
				best = f;
			} else {
				bad = k;
			}
		}
		best!(sink);
		i = good;
	}
}

// the contour as lines and cubics, each run of smooth segments simplified on its own
function simplifyContour(segs: Segment[], closed: boolean, tol: number, quad: boolean, sink: CurveSink) {
	const	n		= segs.length;
	// a closed contour starts at a corner when it has one, so that no run has to span its begin point
	const	first	= closed ? Math.max(0, segs.findIndex((s, i) => isCorner(segs[(i || n) - 1], s))) : 0;
	const	ordered	= [...segs.slice(first), ...segs.slice(0, first)];
	const	loop	= closed && !isCorner(ordered[n - 1], ordered[0]);
	const	dir0	= loop ? normalise(segmentDir(ordered[n - 1].bez, true).add(segmentDir(ordered[0].bez, false))) : segmentDir(ordered[0].bez, false);

	sink.Begin(ordered[0].bez.c0);
	for (let i = 0, j = 1; j <= n; j++) {
		if (j == n || isCorner(ordered[j - 1], ordered[j])) {
			simplifyRun(ordered.slice(i, j), i ? segmentDir(ordered[i].bez, false) : dir0, j == n && loop ? dir0 : segmentDir(ordered[j - 1].bez, true), tol, quad, sink);
			i = j;
		}
	}
	sink.End(!closed);
}

function simplifyContourVertices(curve: curveVertex[], tol: number, quadratic: boolean) {
	const	out: curveVertex[] = [];
	const	sink = curveMaker(out);
	let		segs: Segment[] = [];
	const	add = (bez: bezier3<float2>, emit: Emit = s => s.Bezier3(bez.c0, bez.c1, bez.c2, bez.c3)) => segs.push({bez, emit});

	parseCurve(curve).run({
		Begin()				{ segs = []; },
		Line(a, b)			{
			if (a.sub(b).lensq() > 0)
				add(new bezier3(a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b), s => s.Line(a, b));
		},
		Bezier2(a, b, c)	{ add(new bezier3(a, lerp(a, b, 2 / 3), lerp(c, b, 2 / 3), c), s => s.Bezier2(a, b, c)); },
		Bezier3(a, b, c, d)	{ add(new bezier3(a, b, c, d)); },
		Arc(a, b, c, d)		{
			for (const s of arcToCubics(ArcParams.make2off(a, b, c, d), a, d))
				add(s);
		},
		Arc3(a, b, c)		{
			for (const s of arcToCubics(ArcParams.make1off(a, b, c), a, c))
				add(s);
		},
		End(open)			{
			if (segs.length)
				simplifyContour(segs, !open, tol, quadratic, sink);
		},
	});
	return quadratic ? bezier2Curve(stripImpliedPoints(out), tol) : out;
}

/**
 * Fewer control points for the same shape: runs of consecutive segments between corners are merged into lines and cubics, or with `quadratic` into lines and quadratics,
 * wherever all of it stays within tol of the original. Arcs become cubics (or quadratics) even where not merged.
 */
export function simplifyCurve(curve: curveVertex[], tol: number, quadratic = false) {
	const	out: curveVertex[] = [];
	for (let i = 0, j = 1; i < curve.length; j++) {
		if (j == curve.length || curve[j].flags === ON_BEGIN) {
			const	contour = curve.slice(i, j), simple = simplifyContourVertices(contour, tol, quadratic);
			// a contour that is already as compact as can be found is kept as it was
			const	keep = simple.length >= contour.length && !(quadratic && contour.some(v => v.flags > OFF_BEZ2));
			out.push(...(keep ? contour : simple));
			i = j;
		}
	}
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

	// d2 can come out a rounding error below zero for a point on the curve itself
	return (crossings & 1 ? -1 : 1) * Math.sqrt(Math.max(d2, 0));
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
	curve:		curveVertex[];
	fill:		Fill;
};
