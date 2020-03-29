import * as fs from 'fs';
import * as path from 'path';
import * as shell from 'shelljs';

export function writeDataToFile(fileName: string, data: any) {
	const pathdir = path.dirname(fileName);
	const extension = path.extname(fileName);

	if (!extension) {
		fileName += '.json';
	}

	createDirectory(`./build/data/${pathdir}`);

	fs.writeFile(`./build/data/${pathdir}/${fileName}`,

		JSON.stringify(data),

		(err: any) => {
			if (err) {
				console.error('Crap happens', err);
			}
		});
}

export function createDirectory(fullPath: string) {
	shell.mkdir('-p', fullPath);

	// if (!fs.existsSync(dir)) {
		// fs.mkdirSync(dir);
		// Do something
	// }

}