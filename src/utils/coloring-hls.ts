export function getColorHsl(iter: number, maxIter: number) {
	const h = iter / maxIter;
	const s = 1;
	const l = .5;

	let r;
	let g;
	let b;
	let hue2rgb;

	if (iter === maxIter) {
		return [0,0,0];
	}

	hue2rgb = (a: number, c: number, t: number) => {
		if (t < 0) { t += 1; }
		if (t > 1) { t -= 1; }
		if (t < 1 / 6) { return a + (c - a) * 6 * t; }
		if (t < 1 / 2) { return c; }
		if (t < 2 / 3) { return a + (c - a) * (2 / 3 - t) * 6; }
		return a;
	};

	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	r = hue2rgb(p, q, h + 1 / 3);
	g = hue2rgb(p, q, h);
	b = hue2rgb(p, q, h - 1 / 3);

	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}