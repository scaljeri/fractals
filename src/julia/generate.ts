
import { writeDataToFile } from '../utils/write-file';

const fileName = './build/data/mandelbrot.json';

console.log('Mandelbrot v1.0.0');

const maxIter = 200;

const minR = -0.2;
const maxR = 0.5;
const maxI = .9;
const minI = 0.4;

const stepsR = 1000;
const stepsI = 1000;
const stepSizeR = (maxR - minR) / stepsR;
const stepSizeI = (maxI - minI) / stepsI;

const cR = 0.6;
const cI = 0.55;

const grid: Array<number[]> = [];
let row: number[];

for (let zI = minI; zI < maxI; zI += stepSizeI) {
	row = [];
	for (let zR = minR; zR < maxR; zR += stepSizeR) {
		row.push(determineStability(zR, zI, cR, cI));
	}
	grid.push(row);
}

writeDataToFile('julia', grid);

// ----------------


function determineStability(
	zR: number, zI: number,
	ccR: number, ccI: number,
	count = 0): number {

	// step 1: is this stable
	// if bigger than 2 it is considered NOT STABLE
	if (maxIter === count || (zR ** 2 + zI ** 2) > 8) {
		return count;
	}

	// step 2: compute next value 
	// z**2 + c = 
	//            (a + bi)(a + bi) = a**2 - b**2 + 2abi
	// 			   + 
	//            c = x + yi
	//          =  Real: a**2 - b**2 + x
	//  		   Imag: 2ab + y

	const dumR = zR ** 2 - zI ** 2 + ccR;
	const dumI = 2 * zR * zI + ccI;

	return determineStability(dumR, dumI, ccR, ccI, ++count);
}


