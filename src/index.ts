/// <reference types="node" />

import * as fs from 'fs/promises';
import * as zlib from 'zlib';
import * as bin from '@isopodlabs/binary';
import {load, Font, FontGroup} from './shared';

export * from './shared';

bin.configureDecompression('deflate-raw', buffer => new Promise((resolve, reject) => {
	zlib.inflateRaw(buffer, (err, result) => err ? reject(err) : resolve(result));
}));

bin.configureDecompression('brotli', buffer => new Promise((resolve, reject) => {
	zlib.brotliDecompress(buffer, (err, result) => err ? reject(err) : resolve(result));
}));

export async function loadFile(filename: string): Promise<Font | FontGroup | undefined> {
	return fs.readFile(filename).then(data => load(data));
}
