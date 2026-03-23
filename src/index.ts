import * as fs from 'fs/promises';
import {load, Font, FontGroup} from './shared';
export * from './shared';

export async function loadFile(filename: string): Promise<Font | FontGroup | undefined> {
	return fs.readFile(filename).then(data => load(data));
}
