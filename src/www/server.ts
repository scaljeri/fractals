// tslint:disable-next-line
// console.log('hello world');

import * as fs from 'fs';
import * as bodyParser from 'body-parser';
import * as controllers from './controllers';
import { Server } from '@overnightjs/core';
import { Logger } from '@overnightjs/logger';

export class FractalsServer extends Server {

	private readonly SERVER_STARTED = 'Fractals server started on port: ';

	constructor() {
		super(true);
		this.app.use(bodyParser.json());
		this.app.use(bodyParser.urlencoded({ extended: true }));
		this.setupControllers();
	}

	private setupControllers(): void {
		const ctlrInstances = [];
		for (const name in controllers) {
			if (controllers.hasOwnProperty(name)) {
				const controller = (controllers as any)[name];
				ctlrInstances.push(new controller());
			}
		}
		super.addControllers(ctlrInstances);
	}

	public start(port: number): void {
		this.app.get('*', (req, res) => {
			console.log('Req not catched ' + req.url);
			fs.readFile('./src/www/index.html', 'utf8', (err: any, data: string | Buffer) => {
				if (err) {
					console.log(err);
				}
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.status(200).end(data);
			});
			// res.send(this.SERVER_STARTED + port);
		});
		this.app.listen(port, () => {
			Logger.Imp(this.SERVER_STARTED + port);
		});
	}
}
