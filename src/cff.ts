
import * as binary from '@isopodlabs/binary';
import {curveVertex} from './curves';
import {float2, extent2} from '@isopodlabs/maths/vector';

function as<T>(type: binary.Type) {
	return binary.as(type, i => i as T);
}
//-----------------------------------------------------------------------------
//	Postscript VM
//-----------------------------------------------------------------------------

function roll_stack<T>(array: T[], n: number, j: number) {
	const	s = array.length;
	const	p = s - 1 - n;

	if (j < 0) {
		for (let i = 0; i < j; ++i)
			array[s + i] = array[p + i];
		for (let i = j; i < n; ++i)
			array[p + i + j] = array[p + i];
		for (let i = 0; i < j; ++i)
			array[s + i - j] = array[s + i];
	} else {
		for (let i = n; --i;)
			array[p + i + j] = array[p + i];
		for (let i = 0; i < j; ++i)
			array[p + i] = array[s + i];
	}
}


class PS_VM {
	st:	number[]	= [];
	pt	= float2(0, 0);

	verts:	curveVertex[] = [];

	hstems:		float2[] = [];
	vstems?:	float2[];

	MoveTo(p: float2) {	this.verts.push(new curveVertex(p.x, p.y, curveVertex.ON_BEGIN)); }
	LineTo(p: float2) {	this.verts.push(new curveVertex(p.x, p.y, curveVertex.ON_CURVE)); }
	BezierTo(p1: float2, p2: float2, p3: float2) {
		this.verts.push(new curveVertex(p1.x, p1.y, curveVertex.OFF_BEZ3));
		this.verts.push(new curveVertex(p2.x, p2.y, curveVertex.OFF_BEZ3));
		this.verts.push(new curveVertex(p3.x, p3.y, curveVertex.ON_CURVE));
	}
};

//-----------------------------------------------------------------------------
//	Compact Font Format
//	also known as a PostScript Type 1, or CIDFont
//	container to store multiple fonts together in a single unit known as a FontSet
//	allows embedding PostScript language code that permits additional flexibility and extensibility of the format for usage with printer environments
//-----------------------------------------------------------------------------

const u8 		= binary.UINT8;
const u16 		= binary.UINT16_BE;
const s16 		= binary.INT16_BE;
const s32 		= binary.INT32_BE;

export const enum prop {
	version				= 0x00,
	Notice				= 0x01,
	FullName			= 0x02,
	FamilyName			= 0x03,
	Weight				= 0x04,
	FontBBox			= 0x05,
	BlueValues			= 0x06,
	OtherBlues			= 0x07,
	FamilyBlues			= 0x08,
	FamilyOtherBlues	= 0x09,
	StdHW				= 0x0a,
	StdVW				= 0x0b,
	escape				= 0x0c,
	UniqueID			= 0x0d,
	XUID				= 0x0e,
	charset				= 0x0f,
	Encoding			= 0x10,
	CharStrings			= 0x11,
	Private				= 0x12,
	Subrs				= 0x13,
	defaultWidthX		= 0x14,
	nominalWidthX		= 0x15,
	//-Reserved-		= 0x16-0x1b,
	shortint			= 0x1c,
	longint				= 0x1d,
	BCD					= 0x1e,
	//-Reserved-		= 0x1f,

//	prefixed with 0xc (escape)
	Copyright			= 0x20,
	isFixedPitch		= 0x21,
	ItalicAngle			= 0x22,
	UnderlinePosition	= 0x23,
	UnderlineThickness	= 0x24,
	PaintType			= 0x25,
	CharstringType		= 0x26,
	FontMatrix			= 0x27,
	StrokeWidth			= 0x28,
	BlueScale			= 0x29,
	BlueShift			= 0x2a,
	BlueFuzz			= 0x2b,
	StemSnapH			= 0x2c,
	StemSnapV			= 0x2d,
	ForceBold			= 0x2e,
	//-Reserved-		= 0x2f-0x30,
	LanguageGroup		= 0x31,
	ExpansionFactor		= 0x32,
	initialRandomSeed	= 0x33,
	SyntheticBase		= 0x34,
	PostScript			= 0x35,
	BaseFontName		= 0x36,
	BaseFontBlend		= 0x37,
	//-Reserved-		= 0x38-0x3d,
	ROS					= 0x3e,
	CIDFontVersion		= 0x3f,
	CIDFontRevision		= 0x40,
	CIDFontType			= 0x41,
	CIDCount			= 0x42,
	UIDBase				= 0x43,
	FDArray				= 0x44,
	FDSelect			= 0x45,
	FontName			= 0x46,
};

const header = {
	major_version:	u8,	// Format major version (starting at 1)
	minor_version:	u8,	// Format minor version (starting at 0)
	hdrSize:		u8,	// Header size (bytes)
	offset_size:	u8,	// Absolute offset (0) size
	extra:	binary.Buffer(s => s.obj.hdrSize - 4),
};

const index = {
	get(s: binary.stream) {
		const count = u16.get(s);
		if (count) {
			const offset_size = u8.get(s);
			const offsets	= binary.readn(s, binary.UINT(offset_size * 8, true), count + 1).map(i => Number(i));
			const data		= s.read_buffer(offsets[count] - 1);
			return offsets.slice(0, count).map((i, x) => data.subarray(i - 1, offsets[x + 1] - 1));
		} else {
			return [];
		}
	},
	put(_s: binary._stream) {}
};

function readPackedInt(s: binary._stream, b0: number) {
	return b0 < 247	?  b0 - 139								// 32  < b0 < 246:	bytes:1; range:-107..+107
		 : b0 < 251	? (b0 - 247) * +256 + u8.get(s) + 108	// 247 < b0 < 250:	bytes:2; range:+108..+1131
					: (b0 - 251) * -256 - u8.get(s) - 108;	// 251 < b0 < 254:	bytes:2; range:-1131..-108
}

function writePackedInt(s: binary._stream, t: number) {
	if (Math.abs(t) <= 107) {
		u8.put(s, t + 139);
	} else if (Math.abs(t) <= 1131) {
		if (t < 0) {
			u8.put(s, ((-t - 108) >> 8) + 251);
			u8.put(s, t + 108);
		} else {
			u8.put(s, ((t - 108) >> 8) + 247);
			u8.put(s, t - 108);
		}
	} else if (t <= 32767 && t >= -32768) {
		u8.put(s, prop.shortint);
		s16.put(s, t);
	} else {
		u8.put(s, prop.longint);
		s32.put(s, t);
	}
}

const trans = "0123456789.EE?-";

function readPackedFloat(s: binary._stream) {
	let str = '';
	for (;;) {
		const	b = u8.get(s);
		const	hi = b >> 4, lo = b & 15;
		if (hi === 15)
			break;
		str += trans[hi];
		if (hi == 12)
			str += '-';
		if (lo === 15)
			break;
		str += trans[lo];
		if (lo == 12)
			str += '-';
	};
	return parseFloat(str);
};

function writePackedFloat(s: binary._stream, t: number) {
	const	str = t.toString();
	const	nibbles: number[] = [];
	for (let i = 0; i < str.length;) {
		const c = str[i++];
		let n = trans.indexOf(c);
		if (n == 11 && str[i] === '-') {
			n = 12;
			++i;
		}
		nibbles.push(n);
	}
	nibbles.push(15);
	if (nibbles.length % 2)
		nibbles.push(15);
	for (let i = 0; i < nibbles.length; i += 2)
		u8.put(s, nibbles[i] * 16 + nibbles[i + 1]);
}

function is_hex_digit(i: number) {
	return (i >= 48 && i <= 57) || (i >= 65 && i <= 70) || (i >= 97 && i <= 102);
}

const c1 = 52845, c2 = 22719, eexec_key = 55665, charstring_key = 4330;
class encryption {
	r	= eexec_key;

	encryptByte(b: number) {
		const x = b ^ (this.r >> 8);
		this.r = (x + this.r) * c1 + c2;
		return x;
	}
	decryptByte(x: number) {
		const b = x ^ (this.r >> 8);
		this.r = (x + this.r) * c1 + c2;
		return b;
	}
	encrypt(buffer: Uint8Array) {
		return buffer.map(i => this.encryptByte(i));
	}
	decrypt(buffer: Uint8Array) {
		return buffer.map(i => this.decryptByte(i));
	}

	eexec_decrypt(buffer: Uint8Array) {
		this.r = eexec_key;
		if (is_hex_digit(buffer[0]) && is_hex_digit(buffer[1]) && is_hex_digit(buffer[2]) && is_hex_digit(buffer[3])) {
			//return this.decrypt_ascii(s, dst, len) - s;
		} else {
			this.decrypt(buffer.slice(0, 4));
			return this.decrypt(buffer.slice(4));
		}
	}

	charstring_decrypt(buffer: Uint8Array) {
		//skip might be prvt.lenIV (Version 23.0 requires n to be 4.)
		this.r = charstring_key;
		this.decrypt(buffer.slice(0, 4));
		return this.decrypt(buffer.slice(4));
	}
};

class subrs {
	bias: number;
	constructor(public blocks: Uint8Array[]) {
		this.bias = blocks.length === 0 ? 0 : blocks.length < 1240 ? 107 : blocks.length < 33900 ? 1131 : 32768;
	}
	get(i: number) {
		const block = this.blocks[Math.floor(i) + this.bias];
		return block as Ops;
	}
};

function makeStems(s: number[]) {
	let x	= 0;
	const stems: float2[] = [];
	for (let i = 0; i < s.length; i += 2)
		stems.push(float2(x += s[i], x+= s[i+1]));
	return stems;
}


const enum op {
	hstem			= 0x01,
	vstem			= 0x03,
	vmoveto			= 0x04,
	rlineto			= 0x05,
	hlineto			= 0x06,
	vlineto			= 0x07,
	rrcurveto		= 0x08,
//	closepath		= 0x09,//+
	callsubr		= 0x0a,
	_return			= 0x0b,
	escape			= 0x0c,
//	hsbw			= 0x0d,//+
	endchar			= 0x0e,
	blend			= 0x10,//+
	hstemhm			= 0x12,
	hintmask		= 0x13,
	cntrmask		= 0x14,
	rmoveto			= 0x15,
	hmoveto			= 0x16,
	vstemhm			= 0x17,
	rcurveline		= 0x18,
	rlinecurve		= 0x19,
	vvcurveto		= 0x1a,
	hhcurveto		= 0x1b,
	shortint		= 0x1c,
	callgsubr		= 0x1d,
	vhcurveto		= 0x1e,
	hvcurveto		= 0x1f,

//	prefixed with 0xc (escape)
	dotsection		= 0x20,	// (deprecated)
	//vstem3		= 0x21,//+
	//hstem3		= 0x22,//+
	and				= 0x23,
	or				= 0x24,
	not				= 0x25,
	//seac			= 0x26,//+
	//sbw			= 0x27,//+
	abs				= 0x29,
	add				= 0x2a,
	sub				= 0x2b,
	div				= 0x2c,
	neg				= 0x2e,
	eq				= 0x2f,
	//callothersubr	= 0x30,//+
	//pop			= 0x31,//+
	drop			= 0x32,
	put				= 0x34,
	get				= 0x35,
	ifelse			= 0x36,
	random			= 0x37,
	mul				= 0x38,
	sqrt			= 0x3a,
	dup				= 0x3b,
	exch			= 0x3c,
	index			= 0x3d,
	roll			= 0x3e,
	//setcurrentpoint	= 0x41,//+
	hflex			= 0x42,
	flex			= 0x43,
	hflex1			= 0x44,
	flex1			= 0x45,

	fixed16_16		= 0xff,
};

class Ops extends Uint8Array {
    [index: number]: op;
};

class CFF_VM extends PS_VM {
	temps: 		number[]		= [];
	hintmask?:	Uint8Array;
	cntrmask:	Uint8Array[]	= [];
	cleared		= false;
	dotsection	= false;
	width: 		number;

	gsubrs: subrs;
	lsubrs: subrs;

	stclear(n: number): number[] {
		const	n0	= this.st.length;
		let		p	= 0;
		if (!this.cleared && n0 > n) {
			this.cleared = true;
			this.width	= this.st[p++];
			if (this.width < 0)
				this.width += this.nom_width;
		}
		const result = this.st.slice(p);
		this.st.length = 0;
		return result;
	}

	constructor(gs: Uint8Array[], ls: Uint8Array[], public nom_width: number, default_width: number) {
		super();
		this.width	= default_width;
		this.gsubrs	= new subrs(gs);
		this.lsubrs	= new subrs(ls);
	}
	
	stemBytes() {
		return (this.hstems.length + (this.vstems?.length??0) + 7) >> 3;
	}

	Interpret(ins: Ops) {
		if (!ins)
			return;

		const	st	= (i: number) => this.st.at(~i)!;
		const	set	= (i: number, v: number) => this.st[this.st.length - 1 - i] = v;
		const	set0 = (v: number) => set(0, st0 = v);

		let		st0 = st(0);

		const pop	= () => {
			const top = this.st.pop()!;
			st0 = st(0);
			return top;
		};

		const push	= (v: number) => { this.st.push(st0 = v); };
		const pt	= (array: number[], i: number) => float2(array[i], array[i + 1]);

		let	v: number;
		for (let i = 0; i < ins.length;) {
			let	b0 = ins[i++];
			if (b0 < 0x20) {
				if (b0 == op.escape)
					b0 = ins[i++] + 0x20;
				switch (b0) {
					// unary math ops
					case op.not:		set0(~st0);						break;
					case op.abs:		set0(Math.abs(st0));			break;
					case op.neg:		set0(-st0);						break;
					case op.sqrt:		set0(Math.sqrt(st0));			break;

					// logical ops
					case op.and:		v = pop(); set0(v && st0);		break;
					case op.or:			v = pop(); set0(v || st0);		break;

					// binary math ops
					case op.add:		v = pop(); set0(st0 + v);			break;
					case op.sub:		v = pop(); set0(st0 - v);			break;
					case op.mul:		v = pop(); set0(st0 * v);			break;
					case op.div:		v = pop(); set0(st0 / v);			break;
					case op.eq:			v = pop(); set0(st0 == v ? 1 : 0);	break;

					// stack ops
					case op.drop:		pop();								break;
					case op.dup:		push(st0);							break;
					case op.exch:		v = st(1); set(1, st0); set0(v);	break;
					case op.roll:		v = pop(); roll_stack(this.st, pop(), v);		break;
					case op.index:		push(st(pop()));								break;
					case op.ifelse:
						v = pop();
						if (v < pop())
							set(1, st0);
						pop();
						break;

					// storage ops
					case op.put:		v = pop(); this.temps[Math.floor(v)] = pop();	break;
					case op.get:		set0(this.temps[Math.floor(st0)]);				break;

					// flow control
					case op.callsubr:	this.Interpret(this.lsubrs.get(pop())); break;
					case op.callgsubr:	this.Interpret(this.gsubrs.get(pop()));	break;
					case op._return:		return;
					case op.endchar:	this.stclear(0); return;

					// hint ops
					case op.hstemhm:	//|- y dy {dya dyb}*
					case op.hstem:		//|- y dy {dya dyb}*
						this.hstems = makeStems(this.stclear((this.st.length >> 1) * 2));
						break;
					case op.vstemhm:	//|- x dx {dxa dxb}*
					case op.vstem:		//|- x dx {dxa dxb}*
						this.vstems = makeStems(this.stclear((this.st.length >> 1) * 2));
						break;

					case op.hintmask: {
						if (!this.vstems)
							this.vstems = makeStems(this.stclear((this.st.length >> 1) * 2));
						const bytes = this.stemBytes();
						this.hintmask = ins.slice(i, i + bytes);
						i += bytes;
						break;
					}

					case op.cntrmask: {
						this.stclear(0);
						const bytes = this.stemBytes();
						this.cntrmask.push(ins.slice(i, i + bytes));
						i += bytes;
						break;
					}

					case op.dotsection:
						this.dotsection = !this.dotsection;
						this.st = [];
						break;

					// flex path ops
					case op.flex:	{	//|- dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 dx6 dy6 fd
						const s		= this.st;
						const p1	= this.pt.add(pt(s,0));
						const p2 	= p1.add(pt(s,2));
						const p3 	= p2.add(pt(s,4));
						const p4 	= p3.add(pt(s,6));
						const p5 	= p4.add(pt(s,8));
						this.pt		= p5.add(pt(s,5));
						const _fd	= s[12] * 0.01;
						this.BezierTo(p1, p2, p3);
						this.BezierTo(p4, p5, this.pt);
						this.st		= [];
						break;
					}
					case op.flex1:	{	//|- dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 d6
						const s		= this.st;
						const p1	= this.pt.add(pt(s,0));
						const p2 	= p1.add(pt(s,2));
						const p3 	= p2.add(pt(s,4));
						const p4 	= p3.add(pt(s,6));
						const p5 	= p4.add(pt(s,8));
						const d 	= p5.sub(this.pt);
						this.pt		= p5;
						if (Math.abs(d.x) > Math.abs(d.y))
							this.pt.x += s[10];
						else
							this.pt.y += s[10];
						const _fd	= 0.5;
						this.BezierTo(p1, p2, p3);
						this.BezierTo(p4, p5, this.pt);
						this.st		= [];
						break;
					}
					case op.hflex:	{	//|- dx1 dx2 dy2 dx3 dx4 dx5 dx6
						const s		= this.st;
						const p1	= float2(this.pt.x + s[0], this.pt.y);
						const p2	= p1.add(pt(s,1));
						const x3	= p2.x + s[3];
						const x4	= x3 + s[4];
						const x5	= x4 + s[5];
						this.pt		= float2(x5 + s[6], p2.y);
						const _fd	= 0.5;
						this.BezierTo(p1, p2, float2(x3, p2.y));
						this.BezierTo(float2(x4, p2.y), float2(x5, p2.y), this.pt);
						this.st		= [];
						break;
					}
					case op.hflex1: {	//|- dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6
						const s		= this.st;
						const p1 	= this.pt.add(pt(s,0));
						const p2 	= p1.add(pt(s,2));
						const x3 	= p2.x + s[4];
						const x4 	= x3 + s[5];
						const p5 	= float2(x4, p2.y).add(pt(s,6));
						this.pt 	= float2(p5.x + s[8], p5.y);
						const _fd	= 0.5;
						this.BezierTo(p1, p2, float2(x3, p2.y));
						this.BezierTo(float2(x4, p2.y), p5, this.pt);
						this.st		= [];
						break;
					}

					// path ops
					case op.rmoveto:
						this.pt = this.pt.add(pt(this.stclear(2), 0));
						this.MoveTo(this.pt);
						break;

					case op.hmoveto:
						this.pt.x += this.stclear(1)[0];
						this.MoveTo(this.pt);
						break;

					case op.vmoveto:
						this.pt.y += this.stclear(1)[0];
						this.MoveTo(this.pt);
						break;

					case op.rlineto: {	//|- {dxa dya}+
						const	s	= this.st;
						for (let i = 0; i < s.length; i += 2) {
							this.pt = this.pt.add(pt(s, i));
							this.LineTo(this.pt);
						}
						this.st = [];
						break;
					}

					case op.hlineto: {	//|- dx1 {dya dxb}*
						const	s	= this.st;
						for (let i = 0; i < s.length;) {
							this.pt.x += s[i++];
							this.LineTo(this.pt);
							if (i < s.length) {
								this.pt.y += s[i++];
								this.LineTo(this.pt);
							}
						}
						this.st = [];
						break;
					}

					case op.vlineto: {	//|- dy1 {dxa dyb}*
						const	s	= this.st;
						for (let i = 0; i < s.length;) {
							this.pt.y += s[i++];
							this.LineTo(this.pt);
							if (i < s.length) {
								this.pt.x += s[i++];
								this.LineTo(this.pt);
							}
						}
						this.st = [];
						break;
					}

					case op.rcurveline: {//|- {dxa dya dxb dyb dxc dyc}+ dxd dyd
						const	s	= this.st;
						let		j	= 0;
						for (; j < s.length - 6; j += 6) {
							const p1	= this.pt.add(pt(s, j));
							const p2	= p1.add(pt(s, j + 2));
							this.pt		= p2.add(pt(s, j + 4));
							this.BezierTo(p1, p2, this.pt);
						}
						this.pt = this.pt.add(pt(s, j));
						this.LineTo(this.pt);
						this.st = [];
						break;
					}

					case op.rlinecurve: {//|- {dxa dya}+ dxb dyb dxc dyc dxd dyd
						const	s	= this.st;
						let		j	= 0;
						for (; j < s.length - 6; j += 2) {
							this.pt = this.pt.add(pt(s, j));
							this.LineTo(this.pt);
						}
						const p1	= this.pt.add(pt(s, j));
						const p2	= p1.add(pt(s, j + 2));
						this.pt		= p2.add(pt(s, j + 4));
						this.BezierTo(p1, p2, this.pt);
						this.st = [];
						break;
					}

					case op.rrcurveto: {//|- {dxa dya dxb dyb dxc dyc}+
						const	s	= this.st;
						for (let j = 0; j < s.length; j += 6) {
							const p1	= this.pt.add(pt(s, j));
							const p2	= p1.add(pt(s, j + 2));
							this.pt		= p2.add(pt(s, j + 4));
							this.BezierTo(p1, p2, this.pt);
						}
						this.st = [];
						break;
					}

					case op.hhcurveto: {//|- dy1? {dxa dxb dyb dxc}+
						const	s	= this.st;
						for (let j = 0; j < s.length; j += 4) {
							const	p1 = this.pt;
							if (j == 0 && (s.length & 1))
								p1.y += s[j++];
							p1.x += s[j];
							const p2	= p1.add(pt(s, j + 1));
							this.pt		= float2(p2.x += s[3], p2.y);
							this.BezierTo(p1, p2, this.pt);
						}
						this.st = [];
						break;
					}

					case op.vvcurveto: {//|- dx1? {dya dxb dyb dyc}+
						const	s	= this.st;
						for (let j = 0; j < s.length; j += 4) {
							const p1	= this.pt;
							if (j == 0 && (s.length & 1))
								p1.x += s[j++];
							p1.y		+= s[j];
							const p2	= p1.add(pt(s, j + 1));
							this.pt		= float2(p2.x, p2.y + s[3]);
							this.BezierTo(p1, p2, this.pt);
						}
						this.st = [];
						break;
					}

					case op.hvcurveto: {//|- dx1 dx2 dy2 dy3 {dya dxb dyb dxc dxd dxe dye dyf}* dxf?
						const	s	= this.st;
						for (let j = 0; j < s.length; j += 4) {
							let	p1 = float2(this.pt.x + s[j], this.pt.y);
							let	p2 = p1.add(pt(s, j + 1));
							this.pt = float2(p2.x, p2.y + s[3]);
							j	+= 4;
							if (j == s.length - 1)
								this.pt.x += s[j++];
							this.BezierTo(p1, p2, this.pt);
							if (j < s.length) {
								p1		= this.pt;
								p1.y	+= s[j];
								p2		= p1.add(pt(s, j + 1));
								this.pt = float2(p2.x += s[3], p2.y);
								j	+= 4;
								if (j == s.length - 1)
									this.pt.y += s[j++];
								this.BezierTo(p1, p2, this.pt);
							}
						}
						this.st = [];
						break;
					}

					case op.vhcurveto: {//|- dy1 dx2 dy2 dx3 {dxa dxb dyb dyc dyd dxe dye dxf}* dyf?
						const	s	= this.st;
						for (let j = 0; j < s.length; j += 4) {
							let	p1	= float2(this.pt.x, this.pt.y + s[j]);
							let	p2	= p1.add(pt(s, j + 1));
							this.pt	= float2(p2.x + s[3], p2.y);
							j	+= 4;
							if (j == s.length - 1)
								this.pt.y += s[j++];
							this.BezierTo(p1, p2, this.pt);
							if (j < s.length) {
								p1		= float2(this.pt.x + s[j], this.pt.y);
								p2		= p1.add(pt(s, j + 1));
								this.pt	= float2(p2.x, p2.y + s[3]);
								j	+= 4;
								if (j == s.length - 1)
									this.pt.x += s[j++];
								this.BezierTo(p1, p2, this.pt);
							}
						}
						this.st = [];
						break;
					}

					// misc ops
	//				case op.random:	st.push(random); break;;
					case op.shortint:
						push((ins[i] << 8) + ins[i + 1]);
						i += 2;
						break;

					default:
						console.log(`bad CFF opcode: 0x${b0.toString(16)}`);
						break;
				}

			} else if (b0 == op.fixed16_16) {
				const hi = ins[i + 0] * 256 + ins[i + 1];
				const lo = ins[i + 2] * 256 + ins[i + 3];
				push(hi + lo / 65536);
				i += 4;

			} else {
				push( b0 < 247	?  b0 - 139								// 32  < b0 < 246:	bytes:1; range:-107..+107
					: b0 < 251	? (b0 - 247) * +256 + ins[i++] + 108	// 247 < b0 < 250:	bytes:2; range:+108..+1131
								: (b0 - 251) * -256 - ins[i++] - 108	// 251 < b0 < 254:	bytes:2; range:-1131..-108
				);
			}
		}
	}
}


const PropArray	= (v: number[], _cff: CFF) => v;
const PropDelta	= (v: number[], _cff: CFF) => v;
const PropNumber = (v: number[], _cff: CFF) => v[0];
const PropString = (v: number[], cff: CFF) => cff.getString(v[0]);

const propTypes = {
	[prop.FontBBox]:			(v: number[]) => new extent2(float2(v[0], v[1]), float2(v[2], v[3])),
	[prop.Private]:				(v: number[], cff: CFF, buffer: Uint8Array) => new PrivateDictionary(cff, buffer.subarray(v[1]), v[0]),
	[prop.version]:				PropString,
	[prop.Notice]:				PropString,
	[prop.FullName]:			PropString,
	[prop.FamilyName]:			PropString,
	[prop.Weight]:				PropString,
//	[prop.FontBBox]:			(v: number[]) => new extent2(float2(v[0], v[1]), float2(v[2], v[3])),
	[prop.BlueValues]:			PropDelta,
	[prop.OtherBlues]:			PropDelta,
	[prop.FamilyBlues]:			PropDelta,
	[prop.FamilyOtherBlues]:	PropDelta,
	[prop.StdHW]:				PropNumber,
	[prop.StdVW]:				PropNumber,
	[prop.UniqueID]:			PropNumber,
	[prop.XUID]:				PropArray,
	[prop.charset]:				PropNumber,//resolved later(v: number[], cff: CFF, buffer: Uint8Array) => new Charset(v[0], buffer, cff.numchr),
	[prop.Encoding]:			PropNumber,
	[prop.CharStrings]:			(v: number[], cff: CFF, buffer: Uint8Array) => binary.read(new binary.stream(buffer.subarray(v[0])), index),//as<Ops[]>(index)),
//	[prop.Private]:				(v: number[], cff: CFF, buffer: Uint8Array) => new PrivateDictionary(cff, buffer.subarray(v[1]), v[0]),
	[prop.Subrs]:				(v: number[], cff: CFF, buffer: Uint8Array) => binary.read(new binary.stream(buffer.subarray(v[0])), index),
	[prop.defaultWidthX]:		PropNumber,
	[prop.nominalWidthX]:		PropNumber,
	[prop.shortint]:			PropNumber,
	[prop.Copyright]:			PropString,
	[prop.isFixedPitch]:		(v: number[]) => !!v[0],
	[prop.ItalicAngle]:			PropNumber,
	[prop.UnderlinePosition]:	PropNumber,
	[prop.UnderlineThickness]:	PropNumber,
	[prop.PaintType]:			PropNumber,
	[prop.CharstringType]:		PropNumber,
	[prop.FontMatrix]:			PropArray,
	[prop.StrokeWidth]:			PropNumber,
	[prop.BlueScale]:			PropNumber,
	[prop.BlueShift]:			PropNumber,
	[prop.BlueFuzz]:			PropNumber,
	[prop.StemSnapH]:			PropDelta,
	[prop.StemSnapV]:			PropDelta,
	[prop.ForceBold]:			(v: number[]) => !!v[0],
	[prop.LanguageGroup]:		PropNumber,
	[prop.ExpansionFactor]:		PropNumber,
	[prop.initialRandomSeed]:	PropNumber,
	[prop.SyntheticBase]:		PropNumber,
	[prop.PostScript]:			PropString,
	[prop.BaseFontName]:		PropString,
	[prop.BaseFontBlend]:		PropDelta,
	[prop.ROS]:					(v: number[], cff: CFF) => ({a: cff.getString(v[0]), b: cff.getString(v[1]), c: v[2]}),
	[prop.CIDFontVersion]:		PropNumber,
	[prop.CIDFontRevision]:		PropNumber,
	[prop.CIDFontType]:			PropNumber,
	[prop.CIDCount]:			PropNumber,
	[prop.UIDBase]:				PropNumber,
	[prop.FDArray]:				(v: number[], cff: CFF, buffer: Uint8Array) => binary.read(new binary.stream(buffer.subarray(v[0])), index).map(i => new Dictionary(cff, buffer, i)),
	[prop.FDSelect]:			(v: number[], cff: CFF, buffer: Uint8Array) => binary.read(new binary.stream(buffer.subarray(v[0])), FDSelect),
	[prop.FontName]:			PropString,
};

export type PROP = keyof typeof propTypes;

type dictionary_entries = Record<number, any>;

const dict_top_defaults: dictionary_entries = {
	[prop.version]:				0,
	[prop.Notice]:				1,
	[prop.FullName]:			2,
	[prop.FamilyName]:			3,
	[prop.Weight]:				4,
	[prop.Copyright]:			0x20,
	[prop.BaseFontName]:		0x34,
	[prop.PostScript]:			0x35,
	[prop.isFixedPitch]:		0,
	[prop.ItalicAngle]:			0,
	[prop.UnderlinePosition]:	-100,
	[prop.UnderlineThickness]:	50,
	[prop.PaintType]:			0,
	[prop.CharstringType]:		2,
	[prop.StrokeWidth]:			0,
	[prop.charset]:				0,
	[prop.Encoding]:			0,
	[prop.FontMatrix]:			[0.001, 0, 0, 0.001, 0, 0],
	[prop.FontBBox]:			[0, 0, 0, 0]
};


const private_defaults: dictionary_entries = {
	[prop.BlueScale]:			0.039625,
	[prop.BlueShift]:			7,
	[prop.BlueFuzz]:			1,
	[prop.ForceBold]:			0,
	[prop.LanguageGroup]:		0,
	[prop.ExpansionFactor]:		0.06,
	[prop.initialRandomSeed]:	0,
	[prop.defaultWidthX]:		0,
	[prop.nominalWidthX]:		0,
};

class Dictionary {
	entries: dictionary_entries = {};
	constructor(cff: CFF, buffer: Uint8Array, block: Uint8Array, entries: dictionary_entries = {}) {
		Object.assign(this.entries, entries);

		const s = new binary.stream(block);
		let values: number[] = [];
		while (s.remaining()) {
			let	value = u8.get(s);
			if (value < 0x20) {
				switch (value) {
					case prop.shortint:	value = s16.get(s); break;
					case prop.longint:	value = s32.get(s); break;
					case prop.BCD:		value = readPackedFloat(s); break;
					case prop.escape:
						value = u8.get(s) + 0x20;
						//fall through
					default:
						this.entries[value] = propTypes[value as PROP] ? propTypes[value as PROP](values, cff, buffer) : values;
						values = [];
						continue;
				}
			} else if (value != 0xff) {
				value = readPackedInt(s, value);
			}
			values.push(value);
		}
		return this;
	}
	//lookup(p: prop) {
	//	return this.entries[p];
	//}

	lookup<P extends PROP>(p: P) : ReturnType<typeof propTypes[P]>;
	lookup(p: prop): any;
	lookup(p: prop): any {
		return this.entries[p];
	}

};

class PrivateDictionary extends Dictionary {
	constructor(cff: CFF, public buffer: Uint8Array, length: number, entries: dictionary_entries = {}) {
		super(cff, buffer, buffer.subarray(0, length), entries);
	}
}

enum SID {
	'.notdef',				space,				exclam,				quotedbl,
	numbersign,				dollar,				percent,			ampersand,
	quoteright,				parenleft,			parenright,			asterisk,
	plus,					comma,				hyphen,				period,
	slash,					zero,				one,				two,
	three,					four,				five,				six,
	seven,					eight,				nine,				colon,
	semicolon,				less,				equal,				greater,
	question,				at,					A,					B,
	C,						D,					E,					F,
	G,						H,					I,					J,
	K,						L,					M,					N,
	O,						P,					Q,					R,
	S,						T,					U,					V,
	W,						X,					Y,					Z,
	bracketleft,			backslash,			bracketright,		asciicircum,
	underscore,				quoteleft,			a,					b,
	c,						d,					e,					f,
	g,						h,					i,					j,
	k,						l,					m,					n,
	o,						p,					q,					r,
	s,						t,					u,					v,
	w,						x,					y,					z,
	braceleft,				bar,				braceright,			asciitilde,
	exclamdown,				cent,				sterling,			fraction,
	yen,					florin,				section,			currency,
	quotesingle,			quotedblleft,		guillemotleft,		guilsinglleft,
	guilsinglright,			fi,					fl,					endash,
	dagger,					daggerdbl,			periodcentered,		paragraph,
	bullet,					quotesinglbase,		quotedblbase,		quotedblright,
	guillemotright,			ellipsis,			perthousand,		questiondown,
	grave,					acute,				circumflex,			tilde,
	macron,					breve,				dotaccent,			dieresis,
	ring,					cedilla,			hungarumlaut,		ogonek,
	caron,					emdash,				AE,					ordfeminine,
	Lslash,					Oslash,				OE,					ordmasculine,
	ae,						dotlessi,			lslash,				oslash,
	oe,						germandbls,			onesuperior,		logicalnot,
	mu,						trademark,			Eth,				onehalf,
	plusminus,				Thorn,				onequarter,			divide,
	brokenbar,				degree,				thorn,				threequarters,
	twosuperior,			registered,			minus,				eth,
	multiply,				threesuperior,		copyright,			Aacute,
	Acircumflex,			Adieresis,			Agrave,				Aring,
	Atilde,					Ccedilla,			Eacute,				Ecircumflex,
	Edieresis,				Egrave,				Iacute,				Icircumflex,
	Idieresis,				Igrave,				Ntilde,				Oacute,
	Ocircumflex,			Odieresis,			Ograve,				Otilde,
	Scaron,					Uacute,				Ucircumflex,		Udieresis,
	Ugrave,					Yacute,				Ydieresis,			Zcaron,
	aacute,					acircumflex,		adieresis,			agrave,
	aring,					atilde,				ccedilla,			eacute,
	ecircumflex,			edieresis,			egrave,				iacute,
	icircumflex,			idieresis,			igrave,				ntilde,
	oacute,					ocircumflex,		odieresis,			ograve,
	otilde,					scaron,				uacute,				ucircumflex,
	udieresis,				ugrave,				yacute,				ydieresis,
	zcaron,					exclamsmall,		Hungarumlautsmall,	dollaroldstyle,
	dollarsuperior,			ampersandsmall,		Acutesmall,			parenleftsuperior,
	parenrightsuperior,		twodotenleader,		onedotenleader,		zerooldstyle,
	oneoldstyle,			twooldstyle,		threeoldstyle,		fouroldstyle,
	fiveoldstyle,			sixoldstyle,		sevenoldstyle,		eightoldstyle,
	nineoldstyle,			commasuperior,		threequartersemdash,periodsuperior,
	questionsmall,			asuperior,			bsuperior,			centsuperior,
	dsuperior,				esuperior,			isuperior,			lsuperior,
	msuperior,				nsuperior,			osuperior,			rsuperior,
	ssuperior,				tsuperior,			ff,					ffi,
	ffl,					parenleftinferior,	parenrightinferior,	Circumflexsmall,
	hyphensuperior,			Gravesmall,			Asmall,				Bsmall,
	Csmall,					Dsmall,				Esmall,				Fsmall,
	Gsmall,					Hsmall,				Ismall,				Jsmall,
	Ksmall,					Lsmall,				Msmall,				Nsmall,
	Osmall,					Psmall,				Qsmall,				Rsmall,
	Ssmall,					Tsmall,				Usmall,				Vsmall,
	Wsmall,					Xsmall,				Ysmall,				Zsmall,
	colonmonetary,			onefitted,			rupiah,				Tildesmall,
	exclamdownsmall,		centoldstyle,		Lslashsmall,		Scaronsmall,
	Zcaronsmall,			Dieresissmall,		Brevesmall,			Caronsmall,
	Dotaccentsmall,			Macronsmall,		figuredash,			hypheninferior,
	Ogoneksmall,			Ringsmall,			Cedillasmall,		questiondownsmall,
	oneeighth,				threeeighths,		fiveeighths,		seveneighths,
	onethird,				twothirds,			zerosuperior,		foursuperior,
	fivesuperior,			sixsuperior,		sevensuperior,		eightsuperior,
	ninesuperior,			zeroinferior,		oneinferior,		twoinferior,
	threeinferior,			fourinferior,		fiveinferior,		sixinferior,
	seveninferior,			eightinferior,		nineinferior,		centinferior,
	dollarinferior,			periodinferior,		commainferior,		Agravesmall,
	Aacutesmall,			Acircumflexsmall,	Atildesmall,		Adieresissmall,
	Aringsmall,				AEsmall,			Ccedillasmall,		Egravesmall,
	Eacutesmall,			Ecircumflexsmall,	Edieresissmall,		Igravesmall,
	Iacutesmall,			Icircumflexsmall,	Idieresissmall,		Ethsmall,
	Ntildesmall,			Ogravesmall,		Oacutesmall,		Ocircumflexsmall,
	Otildesmall,			Odieresissmall,		OEsmall,			Oslashsmall,
	Ugravesmall,			Uacutesmall,		Ucircumflexsmall,	Udieresissmall,
	Yacutesmall,			Thornsmall,			Ydieresissmall,		'001.000',
	'001.001',				'001.002',			'001.003',			Black,
	Bold,					Book,				Light,				Medium,
	Regular,				Roman,				Semibold,
};
const nStdStrings = 391;

const PREDEFINED_CHARSETS: Record<number, Record<number, SID>> = {
	0:{//ISOAdobe
		1:	SID.space,				2:	SID.exclam,				3:	SID.quotedbl,		4:	SID.numbersign,
		5:	SID.dollar,				6:	SID.percent,			7:	SID.ampersand,		8:	SID.quoteright,
		9:	SID.parenleft,			10:	SID.parenright,			11:	SID.asterisk,		12:	SID.plus,
		13:	SID.comma,				14:	SID.hyphen,				15:	SID.period,			16:	SID.slash,
		17:	SID.zero,				18:	SID.one,				19:	SID.two,			20:	SID.three,
		21:	SID.four,				22:	SID.five,				23:	SID.six,			24:	SID.seven,
		25:	SID.eight,				26:	SID.nine,				27:	SID.colon,			28:	SID.semicolon,
		29:	SID.less,				30:	SID.equal,				31:	SID.greater,		32:	SID.question,
		33:	SID.at,					34:	SID.A,					35:	SID.B,				36:	SID.C,
		37:	SID.D,					38:	SID.E,					39:	SID.F,				40:	SID.G,
		41:	SID.H,					42:	SID.I,					43:	SID.J,				44:	SID.K,
		45:	SID.L,					46:	SID.M,					47:	SID.N,				48:	SID.O,
		49:	SID.P,					50:	SID.Q,					51:	SID.R,				52:	SID.S,
		53:	SID.T,					54:	SID.U,					55:	SID.V,				56:	SID.W,
		57:	SID.X,					58:	SID.Y,					59:	SID.Z,				60:	SID.bracketleft,
		61:	SID.backslash,			62:	SID.bracketright,		63:	SID.asciicircum,	64:	SID.underscore,
		65:	SID.quoteleft,			66:	SID.a,					67:	SID.b,				68:	SID.c,
		69:	SID.d,					70:	SID.e,					71:	SID.f,				72:	SID.g,
		73:	SID.h,					74:	SID.i,					75:	SID.j,				76:	SID.k,
		77:	SID.l,					78:	SID.m,					79:	SID.n,				80:	SID.o,
		81:	SID.p,					82:	SID.q,					83:	SID.r,				84:	SID.s,
		85:	SID.t,					86:	SID.u,					87:	SID.v,				88:	SID.w,
		89:	SID.x,					90:	SID.y,					91:	SID.z,				92:	SID.braceleft,
		93:	SID.bar,				94:	SID.braceright,			95:	SID.asciitilde,		96:	SID.exclamdown,
		97:	SID.cent,				98:	SID.sterling,			99:	SID.fraction,		100:SID.yen,
		101:SID.florin,				102:SID.section,			103:SID.currency,		104:SID.quotesingle,
		105:SID.quotedblleft,		106:SID.guillemotleft,		107:SID.guilsinglleft,	108:SID.guilsinglright,
		109:SID.fi,					110:SID.fl,					111:SID.endash,			112:SID.dagger,
		113:SID.daggerdbl,			114:SID.periodcentered,		115:SID.paragraph,		116:SID.bullet,
		117:SID.quotesinglbase,		118:SID.quotedblbase,		119:SID.quotedblright,	120:SID.guillemotright,
		121:SID.ellipsis,			122:SID.perthousand,		123:SID.questiondown,	124:SID.grave,
		126:SID.circumflex,			127:SID.tilde,				128:SID.macron,			129:SID.breve,
		130:SID.dotaccent,			131:SID.dieresis,			132:SID.ring,			133:SID.cedilla,
		134:SID.hungarumlaut,		135:SID.ogonek,				136:SID.caron,			137:SID.emdash,
		138:SID.AE,					139:SID.ordfeminine,		140:SID.Lslash,			141:SID.Oslash,
		142:SID.OE,					143:SID.ordmasculine,		144:SID.ae,				145:SID.dotlessi,
		146:SID.lslash,				147:SID.oslash,				148:SID.oe,				149:SID.germandbls,
		150:SID.onesuperior,		151:SID.logicalnot,			152:SID.mu,				153:SID.trademark,
		154:SID.Eth,				155:SID.onehalf,			156:SID.plusminus,		157:SID.Thorn,
		158:SID.onequarter,			159:SID.divide,				160:SID.brokenbar,		161:SID.degree,
		162:SID.thorn,				163:SID.threequarters,		164:SID.twosuperior,	165:SID.registered,
		166:SID.minus,				167:SID.eth,				168:SID.multiply,		169:SID.threesuperior,
		170:SID.copyright,			171:SID.Aacute,				172:SID.Acircumflex,	173:SID.Adieresis,
		174:SID.Agrave,				175:SID.Aring,				176:SID.Atilde,			177:SID.Ccedilla,
		178:SID.Eacute,				179:SID.Ecircumflex,		180:SID.Edieresis,		181:SID.Egrave,
		182:SID.Iacute,				183:SID.Icircumflex,		184:SID.Idieresis,		185:SID.Igrave,
		186:SID.Ntilde,				187:SID.Oacute,				188:SID.Ocircumflex,	189:SID.Odieresis,
		190:SID.Ograve,				191:SID.Otilde,				192:SID.Scaron,			193:SID.Uacute,
		194:SID.Ucircumflex,		195:SID.Udieresis,			196:SID.Ugrave,			197:SID.Yacute,
		198:SID.Ydieresis,			199:SID.Zcaron,				200:SID.aacute,			201:SID.acircumflex,
		202:SID.adieresis,			203:SID.agrave,				204:SID.aring,			205:SID.atilde,
		206:SID.ccedilla,			207:SID.eacute,				208:SID.ecircumflex,	209:SID.edieresis,
		210:SID.egrave,				211:SID.iacute,				212:SID.icircumflex,	213:SID.idieresis,
		214:SID.igrave,				215:SID.ntilde,				216:SID.oacute,			217:SID.ocircumflex,
		218:SID.odieresis,			219:SID.ograve,				220:SID.otilde,			221:SID.scaron,
		222:SID.uacute,				223:SID.ucircumflex,		224:SID.udieresis,		225:SID.ugrave,
		226:SID.yacute,				227:SID.ydieresis,			228:SID.zcaron
	},
	1:{//SID.Expert
 		1:	SID.space,				229:SID.exclamsmall,		230:SID.Hungarumlautsmall,231:SID.dollaroldstyle,
		232:SID.dollarsuperior,		233:SID.ampersandsmall,		234:SID.Acutesmall,		235:SID.parenleftsuperior,
		236:SID.parenrightsuperior,	237:SID.twodotenleader,		238:SID.onedotenleader,	13:	SID.comma,
		14:	SID.hyphen,				15:	SID.period,				99:	SID.fraction,		239:SID.zerooldstyle,
		240:SID.oneoldstyle,		241:SID.twooldstyle,		242:SID.threeoldstyle,	243:SID.fouroldstyle,
		244:SID.fiveoldstyle,		245:SID.sixoldstyle,		246:SID.sevenoldstyle,	247:SID.eightoldstyle,
		248:SID.nineoldstyle,		27:	SID.colon,				28:	SID.semicolon,		249:SID.commasuperior,
		250:SID.threequartersemdash,251:SID.periodsuperior,		252:SID.questionsmall,	253:SID.asuperior,
		254:SID.bsuperior,			255:SID.centsuperior,		256:SID.dsuperior,		257:SID.esuperior,
		258:SID.isuperior,			259:SID.lsuperior,			260:SID.msuperior,		261:SID.nsuperior,
		262:SID.osuperior,			263:SID.rsuperior,			264:SID.ssuperior,		265:SID.tsuperior,
		266:SID.ff,					109:SID.fi,					110:SID.fl,				268:SID.ffl,
		269:SID.parenleftinferior,	270:SID.parenrightinferior,	271:SID.Circumflexsmall,272:SID.hyphensuperior,
		273:SID.Gravesmall,			274:SID.Asmall,				275:SID.Bsmall,			276:SID.Csmall,
		277:SID.Dsmall,				278:SID.Esmall,				279:SID.Fsmall,			280:SID.Gsmall,
		281:SID.Hsmall,				282:SID.Ismall,				283:SID.Jsmall,			284:SID.Ksmall,
		285:SID.Lsmall,				286:SID.Msmall,				287:SID.Nsmall,			288:SID.Osmall,
		289:SID.Psmall,				290:SID.Qsmall,				291:SID.Rsmall,			292:SID.Ssmall,
		293:SID.Tsmall,				294:SID.Usmall,				295:SID.Vsmall,			296:SID.Wsmall,
		297:SID.Xsmall,				298:SID.Ysmall,				299:SID.Zsmall,			300:SID.colonmonetary,
		301:SID.onefitted,			302:SID.rupiah,				303:SID.Tildesmall,		304:SID.exclamdownsmall,
		305:SID.centoldstyle,		306:SID.Lslashsmall,		307:SID.Scaronsmall,	308:SID.Zcaronsmall,
		309:SID.Dieresissmall,		310:SID.Brevesmall,			311:SID.Caronsmall,		312:SID.Dotaccentsmall,
		313:SID.Macronsmall,		314:SID.figuredash,			315:SID.hypheninferior,	316:SID.Ogoneksmall,
		317:SID.Ringsmall,			318:SID.Cedillasmall,		158:SID.onequarter,		155:SID.onehalf,
		163:SID.threequarters,		319:SID.questiondownsmall,	320:SID.oneeighth,		321:SID.threeeighths,
		322:SID.fiveeighths,		323:SID.seveneighths,		324:SID.onethird,		325:SID.twothirds,
		326:SID.zerosuperior,		150:SID.onesuperior,		164:SID.twosuperior,	169:SID.threesuperior,
		327:SID.foursuperior,		328:SID.fivesuperior,		329:SID.sixsuperior,	330:SID.sevensuperior,
		331:SID.eightsuperior,		332:SID.ninesuperior,		333:SID.zeroinferior,	334:SID.oneinferior,
		335:SID.twoinferior,		336:SID.threeinferior,		337:SID.fourinferior,	338:SID.fiveinferior,
		339:SID.sixinferior,		340:SID.seveninferior,		341:SID.eightinferior,	342:SID.nineinferior,
		343:SID.centinferior,		344:SID.dollarinferior,		345:SID.periodinferior,	346:SID.commainferior,
		347:SID.Agravesmall,		348:SID.Aacutesmall,		349:SID.Acircumflexsmall,350:SID.Atildesmall,
		351:SID.Adieresissmall,		352:SID.Aringsmall,			353:SID.AEsmall,		354:SID.Ccedillasmall,
		355:SID.Egravesmall,		356:SID.Eacutesmall,		357:SID.Ecircumflexsmall,358:SID.Edieresissmall,
		359:SID.Igravesmall,		360:SID.Iacutesmall,		361:SID.Icircumflexsmall,362:SID.Idieresissmall,
		363:SID.Ethsmall,			364:SID.Ntildesmall,		365:SID.Ogravesmall,	366:SID.Oacutesmall,
		367:SID.Ocircumflexsmall,	368:SID.Otildesmall,		369:SID.Odieresissmall,	370:SID.OEsmall,
		371:SID.Oslashsmall,		372:SID.Ugravesmall,		373:SID.Uacutesmall,	374:SID.Ucircumflexsmall,
		375:SID.Udieresissmall,		376:SID.Yacutesmall,		377:SID.Thornsmall,		378:SID.Ydieresissmall,
	},
	2:{//ExpertSubset
		1:	SID.space,				231:SID.dollaroldstyle,		232:SID.dollarsuperior,	235:SID.parenleftsuperior,
		236:SID.parenrightsuperior,	237:SID.twodotenleader,		238:SID.onedotenleader,	13:	SID.comma,
		14:	SID.hyphen,				15:	SID.period,				99:	SID.fraction,		239:SID.zerooldstyle,
		240:SID.oneoldstyle,		241:SID.twooldstyle,		242:SID.threeoldstyle,	243:SID.fouroldstyle,
		244:SID.fiveoldstyle,		245:SID.sixoldstyle,		246:SID.sevenoldstyle,	247:SID.eightoldstyle,
		248:SID.nineoldstyle,		27:	SID.colon,				28:	SID.semicolon,		249:SID.commasuperior,
		250:SID.threequartersemdash,251:SID.periodsuperior,		253:SID.asuperior,		254:SID.bsuperior,
		255:SID.centsuperior,		256:SID.dsuperior,			257:SID.esuperior,		258:SID.isuperior,
		259:SID.lsuperior,			260:SID.msuperior,			261:SID.nsuperior,		262:SID.osuperior,
		263:SID.rsuperior,			264:SID.ssuperior,			265:SID.tsuperior,		266:SID.ff,
		109:SID.fi,					110:SID.fl,					267:SID.ffi,			268:SID.ffl,
		269:SID.parenleftinferior,	270:SID.parenrightinferior,	272:SID.hyphensuperior,	300:SID.colonmonetary,
		301:SID.onefitted,			302:SID.rupiah,				305:SID.centoldstyle,	314:SID.figuredash,
		315:SID.hypheninferior,		158:SID.onequarter,			155:SID.onehalf,		163:SID.threequarters,
		320:SID.oneeighth,			321:SID.threeeighths,		322:SID.fiveeighths,	323:SID.seveneighths,
		324:SID.onethird,			325:SID.twothirds,			326:SID.zerosuperior,	150:SID.onesuperior,
		164:SID.twosuperior,		169:SID.threesuperior,		327:SID.foursuperior,	328:SID.fivesuperior,
		329:SID.sixsuperior,		330:SID.sevensuperior,		331:SID.eightsuperior,	332:SID.ninesuperior,
		333:SID.zeroinferior,		334:SID.oneinferior,		335:SID.twoinferior,	336:SID.threeinferior,
		337:SID.fourinferior,		338:SID.fiveinferior,		339:SID.sixinferior,	340:SID.seveninferior,
		341:SID.eightinferior,		342:SID.nineinferior,		343:SID.centinferior,	344:SID.dollarinferior,
		345:SID.periodinferior,		346:SID.commainferior,
	},	
};
	
class Charset {
	static Reader = binary.Switch(u8, {
		0: binary.ArrayType(s => s.obj.count, u16),
		1: binary.RemainingArrayType(binary.as({first: u16, nLeft: u8},		(v, s) => v.first + v.nLeft < s.obj.count ? v : undefined)),
		2: binary.RemainingArrayType(binary.as({first: u16, nLeft: u16},	(v, s) => v.first + v.nLeft < s.obj.count ? v : undefined)),
	});

	table: any;//Record<number, SID>;

	constructor(index: number, buffer: Uint8Array, public count: number) {
		if (index <= 2) {
			this.table = PREDEFINED_CHARSETS[index];
		} else {
			this.table = binary.read(new binary.stream(buffer.subarray(index)), Charset.Reader, this);
		}
	}
}

abstract class FDSelector {
	abstract get(i: number): number;
}

const FDSelect = {
	format:	u8,
	data: as<FDSelector>(binary.Switch(s => s.obj.format, {
		0: class X0 extends binary.Class(binary.RemainingArrayType(u8)) {
			get(i: number) { return this[i]; }
		},
		3: class X3 extends binary.Class({
			ranges: binary.ArrayType(u16, {first: u16, fd: u8}),
			sentinel: u16
		}) {
			constructor(s: binary._stream) {
				super(s);
			}
			get(i: number) {
				let j = this.ranges.findIndex(r => r.first > i);
				if (j < 0)
					j = this.ranges.length;
				return this.ranges[j - 1].fd;
			}
		}
	}))
};

export class CFF extends binary.Class({
	h:			header,
	names:		binary.as(index, blocks => blocks.map(i => binary.utils.decodeText(i))),
	indices:	index,
	strings:	binary.as(index, blocks => blocks.map(i => binary.utils.decodeText(i))),
	gsubrs:		index,
}) {
//	static get(file: binary._stream) { return new this(file); }
	
	pub_dict:	Dictionary;
	nominalWidth	= private_defaults[prop.nominalWidthX][0];
	charset?:	Charset;

	constructor(s: binary._stream) {
		const buffer	= s.remainder();
		super(s);

		this.pub_dict = new Dictionary(this, buffer, this.indices[0], dict_top_defaults);

		const e2 = this.pub_dict.lookup(prop.charset);
		if (e2)
			this.charset	= new Charset(e2, buffer, this.pub_dict.lookup(prop.CharStrings).length);
	}

	getString(sid: number) {
		return sid < nStdStrings ? Object.keys(SID)[sid] : this.strings[sid - nStdStrings];
	}

	getPrivate(id: number) {
		const fdselect = this.pub_dict.lookup(prop.FDSelect);
		return fdselect
			? this.pub_dict.lookup(prop.FDArray)![fdselect.data.get(id)].lookup(prop.Private)
			: this.pub_dict.lookup(prop.Private);
	}

	getGlyph(id: number) {
		const chrstr = this.pub_dict.lookup(prop.CharStrings);
		const i		= chrstr?.[id];
		const dict	= this.getPrivate(id);
		if (i && dict) {
			const lsubrs	= dict.lookup(prop.Subrs);
			const vm		= new CFF_VM(this.gsubrs, lsubrs, this.nominalWidth, dict.lookup(prop.defaultWidthX) || 0);

			vm.Interpret(i as Ops);

			const bb = this.pub_dict.lookup(prop.FontBBox);
			return {
				min: bb.min,
				max: bb.max,
				curve: vm.verts,
			};
		}
	}
}
