/// <reference types="node" />

import * as fs from 'fs';
import * as zlib from 'zlib';
import * as bin from '@isopodlabs/binary';
import {load, loadAsync, Font, FontGroup, AsyncFont, AsyncFontGroup } from './common';

export * from './common';

bin.configureDecompression('deflate-raw', buffer => new Promise((resolve, reject) => {
	zlib.inflateRaw(buffer, (err, result) => err ? reject(err) : resolve(result));
}));

bin.configureDecompression('brotli', buffer => new Promise((resolve, reject) => {
	zlib.brotliDecompress(buffer, (err, result) => err ? reject(err) : resolve(result));
}));

bin.configureCompression('brotli', buffer => new Promise((resolve, reject) => {
	zlib.brotliCompress(buffer, {params: {
		[zlib.constants.BROTLI_PARAM_MODE]:		zlib.constants.BROTLI_MODE_FONT,
		[zlib.constants.BROTLI_PARAM_QUALITY]:	11,
		[zlib.constants.BROTLI_PARAM_SIZE_HINT]:	buffer.length,
	}}, (err, result) => err ? reject(err) : resolve(result));
}));

export function loadFileSync(filename: string): Font | FontGroup | Promise<Font> | undefined {
	return load(fs.readFileSync(filename));
}

export async function loadFile(filename: string): Promise<Font | FontGroup | undefined> {
	return fs.promises.readFile(filename).then(data => load(data));
}

export async function loadFileAsync(filename: string) : Promise< AsyncFont | AsyncFontGroup | undefined> {
	const file = await fs.promises.open(filename, 'r');
	try {
		const stream = new bin.async.stream(
			(offset, data) => file.read(data, 0, data.length, offset).then(r => r.bytesRead),
		);
		return await loadAsync(stream);
	} finally {
		await file.close().catch(() => {});
	}

}
