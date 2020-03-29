import * as fs from 'fs';
import { OK, BAD_REQUEST } from 'http-status-codes';
import { Request, Response } from 'express';
import { Controller, Middleware, Get, Put, Post, Delete } from '@overnightjs/core';
import { Logger } from '@overnightjs/logger';

@Controller('')
export class CodeController {

	@Get('code/:fractal')
	private getFractal(req: Request, res: Response) {
		const fractal = req.params.fractal;
		Logger.Info(`Code: loading ${fractal}`);

		fs.readFile(`./build/code/${fractal}/index.js`, 'utf8', (err: any, data: string | Buffer) => {
			if (err) {
				// tslint:disable-next-line
				console.error(err);
			}
			res.writeHead(200, { 'Content-Type': 'text/javascript' });
			res.status(200).end(data);
		});
	}

	@Get('utils/:filename')
	private getUtils(req: Request, res: Response) {
		const file = req.params.filename;
		Logger.Info(`load file: /build/code/utils/${file}.js`);

		fs.readFile(`./build/code/utils/${file}.js`, 'utf8', (err: any, data: string | Buffer) => {
			if (err) {
				// tslint:disable-next-line
				console.error(err);
			}

			res.writeHead(200, { 'Content-Type': 'text/javascript' });
			res.status(OK).end(data);
		});

		// res.status(OK).json({
		// 	message: req.params.msg,
		// });
	}
}