import { float2, reflect, float2x2, float2x3, max_circle_point, mid }  from '@isopodlabs/maths/vector';
import { circle } from '@isopodlabs/maths/geometry';

export interface color {
	r: number,
	g: number,
	b: number,
	a: number,
}

//-----------------------------------------------------------------------------
//	curves
//-----------------------------------------------------------------------------

export class curveVertex {
	static readonly ON_BEGIN	= 0;
	static readonly ON_CURVE	= 1;
	static readonly OFF_BEZ2	= 2;
	static readonly OFF_BEZ3	= 3;
	static readonly OFF_ARC		= 8;
	static readonly ON_ARC		= 9;
	
	constructor(public x: number, public y: number, public flags: number) {
	}
	get pos() { return float2(this.x, this.y); }
}

export function makeCurveVertex(pt: float2, flags: number) {
	return new curveVertex(pt.x, pt.y, flags);
}

export function reverseCurve(curve: curveVertex[]) {
	for (let i = 0, e = curve.length; i != e;) {
		let	z = ++i;
		while (z != e && curve[z].flags != curveVertex.ON_BEGIN)
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
		if (curve[i].flags == curveVertex.ON_BEGIN) {
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
	const next	= curve[mini + 1 == curve.length || mini + 1 == min1 ? min0 : mini + 1].pos;
	const prev	= curve[(mini == 0 || mini == min0 ? min1 : mini) - 1].pos;

	return next.sub(curve[mini].pos).cross(curve[mini].pos.sub(prev)) < 0;
}

export function transformCurve(curve: curveVertex[] | undefined, transform: float2x3) {
	return curve ? curve.map(i => makeCurveVertex(transform.mulPos(i.pos), i.flags)) : [];
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
		return new ArcParams(float2(axis2.len() * r, axis1.len() * r), -Math.atan2(axis1.y, axis1.x), m0.det() < 0, s < 0);
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
	run(sink: CurveSink):void;
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
	let prev_flags		= curveVertex.ON_BEGIN;
	let prev2_flags 	= curveVertex.ON_BEGIN;

	function on_curve(t: CurveSink, pt: float2) {
		switch (prev_flags) {
			case curveVertex.ON_BEGIN:
			case curveVertex.ON_CURVE:
			case curveVertex.ON_ARC:	t.Line(prev, pt); break;
			case curveVertex.OFF_BEZ2:	t.Bezier2(prev2, prev, pt); break;
			case curveVertex.OFF_BEZ3:	t.Bezier3(prev3, prev2, prev, pt); break;
			case curveVertex.OFF_ARC:
				if (prev2_flags == curveVertex.OFF_ARC) {
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
		run(sink: CurveSink) {
			for (const i of curves) {
				let flags	= i.flags;
				let pt		= float2(i.x, i.y);
				switch (flags) {
					case curveVertex.ON_BEGIN:
						if (prev_flags) {
							on_curve(sink, start);
							sink.End();
						}
						sink.Begin(pt);
						start	= pt;
						break;
		
					case curveVertex.ON_CURVE:
						on_curve(sink, pt);
						break;
		
					case curveVertex.OFF_BEZ2:
						if (prev_flags > 1)
							on_curve(sink, mid(prev, pt));
						break;
		
					case curveVertex.OFF_BEZ3:
						if (prev_flags == 8) {
							on_curve(sink, pt);
							[pt, prev] = [prev, pt];
		
						} else if (prev_flags > 2 && prev2_flags > 1) {
							on_curve(sink, mid(prev, pt));
							prev	= mid(prev, pt);
							flags	= curveVertex.OFF_BEZ2;
						}
						break;
		
					case curveVertex.OFF_ARC:
						break;
		
					case curveVertex.ON_ARC:
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
				prev_flags = curveVertex.ON_BEGIN;
			}
		}
	};
}

export function curveExtent(source: CurveSource) {
	const ext = new float2.extent;
	function pt(p: float2) { ext.add(p); }
	const sink: CurveSink = {
		Begin(a: float2) 									{ pt(a); },
		End() 												{ },
		Line(a: float2, b: float2) 							{ pt(b); },
		Bezier2(a: float2, b: float2, c: float2) 			{ pt(b); pt(c);	},
		Bezier3(a: float2, b: float2, c: float2, d: float2) { pt(b); pt(c);	pt(d); },
		Arc(a: float2, b: float2, c: float2, d: float2) 	{ pt(b); pt(c);	pt(d); },
		Arc3(a: float2, b: float2, c: float2) 				{ pt(b); pt(c);	}
	};
	source.run(sink);
	return ext;
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

	const sink = {
		Begin(p0: float2) {
			commands.push({command: 'M', params: [p0.x, -p0.y]});
		},
		End() {
		},
		Line(p0: float2, p1: float2) {
			commands.push({command: 'L', params: [p1.x, -p1.y]});
		},
		Bezier2(p0: float2, p1: float2, p2: float2) {
			commands.push({command: 'Q', params: [p1.x, -p1.y, p2.x, -p2.y]});
		},
		Bezier3(p0: float2, p1: float2, p2: float2, p3: float2) {
			commands.push({command: 'C', params: [p1.x, -p1.y, p2.x, -p2.y, p3.x, -p3.y]});
		},
		Arc3(_p0: float2, _p1: float2, _p2: float2) {},
		Arc(_p0: float2, _p1: float2, _p2: float2, _p3: float2) {},
	};
	
	source.run(sink);
	return commands.map(c => c.command + c.params.map(i => i.toString()).join(',')).join('');
}

export function parseSVGpath(path: string): CurveSource {
	let prev2 = float2(0, 0);
	const prev = float2(0, 0);

	function X(x: number) 		{ prev.x = x; return x; }
	function Y(y: number) 		{ prev.y = y; return y; }

	function process(sink: CurveSink, command: string, params: number[]) {
		const start	= prev;
		function Xp(i: number) 		{ return X(params[i]); }
		function Yp(i: number) 		{ return Y(params[i]); }
		function XYp(i: number) 	{ return float2(Xp(i), Yp(i + 1)); }
		function Xrelp(i: number) 	{ return X(start.x + params[i]); }
		function Yrelp(i: number) 	{ return Y(start.y + params[i]); }
		function XYrelp(i: number)	{ return float2(Xrelp(i), Yrelp(i + 1)); }
	
		switch (command) {
			case 'M': sink.Begin(XYp(0)); break;
			case 'L': sink.Line(prev, XYp(0)); break;
			case 'H': sink.Line(prev, float2(Xp(0), prev.y)); break;
			case 'V': sink.Line(prev, float2(prev.x, Yp(0))); break;
			case 'Q': sink.Bezier2(prev, (prev2 = XYp(0)), XYp(2)); break;
			case 'T': sink.Bezier2(prev2, prev, XYp(0)); break;
			case 'C': sink.Bezier3(prev, XYp(0), (prev2 = XYp(2)), XYp(4)); break;
			case 'S': sink.Bezier3(prev2, prev, (prev2 = XYp(0)), XYp(2)); break;
			case 'A': {
				const ap = new ArcParams(float2(params[0], params[1]), params[2], !!params[3], !!params[4]);
				const c0 = prev;
				const c3 = XYp(5);
				const cp = ap.control_points(c0, c3);
				sink.Arc(c0, cp[0], cp[1], c3);
				break;
			}
			case 'm': sink.Begin(XYrelp(0)); break;
			case 'l': sink.Line(prev, XYrelp(0)); break;
			case 'h': sink.Line(prev, float2(Xrelp(0), prev.y)); break;
			case 'v': sink.Line(prev, float2(prev.x, Yrelp(0))); break;
			case 'q': sink.Bezier2(prev, XYrelp(0), XYrelp(2)); break;
			case 't': sink.Bezier2(prev2, prev, XYrelp(0)); break;
			case 'c': sink.Bezier3(prev, XYrelp(0), XYrelp(2), XYrelp(4)); break;
			case 's': sink.Bezier3(prev2, prev, (prev2 = XYrelp(0)), XYrelp(2)); break;
			case 'a': {
				const ap = new ArcParams(float2(params[0], params[1]), params[2], !!params[3], !!params[4]);
				const c0 = prev;
				const c3 = XYrelp(5);
				const cp = ap.control_points(c0, c3);
				sink.Arc(c0, cp[0], cp[1], c3);
				break;
			}
		}
	}
	return {
		run(sink: CurveSink) {
			const commands = path.split(/(?=[a-zA-Z])/).slice(1);
			for (const i of commands) {
				const params0 = i.slice(1).trim();
				if (params0) {
					const params = params0.split(/[ ,]/).map(j => parseFloat(j));
					process(sink, i[0], params);
				}
			}
		}
	};
}
