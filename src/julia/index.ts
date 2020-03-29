import { getColorHsl } from '../utils/coloring-hls';

fetch('data/mandelbrot')
	.then((response) => {
		return response.json();
	})
	.then((data: number[][]) => {
		const canvas = document.querySelector('canvas') as HTMLCanvasElement;
		const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

		canvas.width = data[0].length;
		canvas.height = data.length;

		data.forEach((row, y) => {
			row.forEach((value, x) => {
				if (value === 200) {
					ctx.fillStyle = 'black';
				} else {
					ctx.fillStyle = 'rgb(' + getColorHsl(value, 200).join(', ') + ')';
				}

				ctx.fillRect(x, y, 1, 1);
			});
		})
	});