export type Decompressor = (buffer: Uint8Array) => Promise<Uint8Array>;

let inflateImpl: Decompressor | undefined;
let brotliImpl: Decompressor | undefined;

function missing(name: string): never {
	throw new Error(`${name} decompression is not configured for this environment`);
}

export function setInflate(fn: Decompressor) {
	inflateImpl = fn;
}

export function setBrotli(fn: Decompressor) {
	brotliImpl = fn;
}

export function configureCompression(options: {inflate?: Decompressor; brotli?: Decompressor}) {
	if (options.inflate)
		inflateImpl = options.inflate;
	if (options.brotli)
		brotliImpl = options.brotli;
}

export function inflate(buffer: Uint8Array) {
	return (inflateImpl ?? (() => missing('Deflate')))(buffer);
}

export function brotli(buffer: Uint8Array) {
	return (brotliImpl ?? (() => missing('Brotli')))(buffer);
}

export function decodeText(buffer: Uint8Array) {
	return new TextDecoder().decode(buffer);
}