export function colorGrid(iter: number, maxIterations: number): number[] {
	const ratio = iter / maxIterations;
	let red = 0;
	let green = 0;
	let blue = 0;

	if ((ratio >= 0) && (ratio < 0.125)) {
		red = (ratio / 0.125) * (512) + 0.5;
		green = 0;
		blue = 0;
	}

	if ((ratio >= 0.125) && (ratio < 0.250)) {
		red = 255;
		green = (((ratio - 0.125) / 0.125) * (512) + 0.5);
		blue = 0;
	}

	if ((ratio >= 0.250) && (ratio < 0.375)) {
		red = ((1.0 - ((ratio - 0.250) / 0.125)) * (512) + 0.5);
		green = 255;
		blue = 0;
	}

	if ((ratio >= 0.375) && (ratio < 0.500)) {
		red = 0;
		green = 255;
		blue = (((ratio - 0.375) / 0.125) * (512) + 0.5);
	}

	if ((ratio >= 0.500) && (ratio < 0.625)) {
		red = 0;
		green = ((1.0 - ((ratio - 0.500) / 0.125)) * (512) + 0.5);
		blue = 255;
	}

	if ((ratio >= 0.625) && (ratio < 0.750)) {
		red = (((ratio - 0.625) / 0.125) * (512) + 0.5);
		green = 0;
		blue = 255;
	}

	if ((ratio >= 0.750) && (ratio < 0.875)) {
		red = 255;
		green = (((ratio - 0.750) / 0.125) * (512) + 0.5);
		blue = 255;
	}

	if ((ratio >= 0.875) && (ratio <= 1.000)) {
		red = ((1.0 - ((ratio - 0.875) / 0.125)) * (512) + 0.5);
		green = ((1.0 - ((ratio - 0.875) / 0.125)) * (512) + 0.5);
		blue = ((1.0 - ((ratio - 0.875) / 0.125)) * (512) + 0.5);
	}

	return [toInteger(red), toInteger(green), toInteger(blue)];
}

function toInteger(num: number): number {
	return Math[num < 0 ? 'ceil' : 'floor'](num);
}