import * as fs from 'fs';
import { OK, BAD_REQUEST } from 'http-status-codes';
import { Request, Response } from 'express';
import { Controller, Middleware, Get, Put, Post, Delete } from '@overnightjs/core';
import { Logger } from '@overnightjs/logger';

@Controller('data')
export class DataController {

	@Get(':fractal')
	private getHtMl(req: Request, res: Response) {
		const fractal = req.params.fractal;
		Logger.Info(`Page: loading ${fractal}`);

		fs.readFile(`./build/data/${fractal}.json`, 'utf8', (err: any, data: string | Buffer) => {
			if (err) {
				// tslint:disable-next-line
				console.error(err);
			}
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.status(200).end(data);
		});
	}

	@Get(':name')
	private getData(req: Request, res: Response) {
		const file = req.params.name;
		Logger.Info(`Data: /build/data/${file}.json`);

		fs.readFile(`./build/data/${file}.json`, 'utf8', (err: any, data: string | Buffer) => {
			if (err) {
				// tslint:disable-next-line
				console.error(err);
			}

			res.writeHead(200, { 'Content-Type': 'text/json' });
			res.status(OK).end(data);
		});

		// res.status(OK).json({
		// 	message: req.params.msg,
		// });
	}

	// @Put(':msg')
	// private putMessage(req: Request, res: Response) {
	// 	Logger.Info(req.params.msg);
	// 	return res.status(400).json({
	// 		error: req.params.msg,
	// 	});
	// }

	// @Post(':msg')
	// private postMessage(req: Request, res: Response) {
	// 	Logger.Info(req.params.msg);
	// 	return res.status(400).json({
	// 		error: req.params.msg,
	// 	});
	// }

	// @Delete(':msg')
	// private delMessage(req: Request, res: Response) {
	// 	try {
	// 		throw new Error(req.params.msg);
	// 	} catch (err) {
	// 		Logger.Err(err, true);
	// 		return res.status(400).json({
	// 			error: req.params.msg,
	// 		});
	// 	}
	// }
}