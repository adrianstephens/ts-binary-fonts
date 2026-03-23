import {configureCompression} from './runtime';

async function decompress(format: string, buffer: Uint8Array) {
	const DecompressionStreamCtor = (globalThis as any).DecompressionStream;
	if (!DecompressionStreamCtor)
		throw new Error(`DecompressionStream is not available for ${format}`);

	const stream	= new DecompressionStreamCtor(format);
	const writer	= stream.writable.getWriter();
	await writer.write(buffer);
	await writer.close();
	return new Uint8Array(await new (globalThis as any).Response(stream.readable).arrayBuffer());
}

configureCompression({
	inflate:	buffer => decompress('deflate', buffer),
	brotli:	buffer => decompress('brotli', buffer),
});

export * from './shared';