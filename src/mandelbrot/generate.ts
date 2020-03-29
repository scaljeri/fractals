
import { writeDataToFile } from '../utils/write-file';

const fileName = './build/data/mandelbrot.json';

console.log('Mandelbrot v1.0.0');

const maxIter = 200;

const maxR = 1.5;
const maxI = 2;
const minR = -2.5;
const minI = -2;

const stepsR = 1000;
const stepsI = 1000;
const stepSizeR = (maxR - minR) / stepsR;
const stepSizeI = (maxI - minI) / stepsI;

let zR: number;
let zI: number;

// Begin
zR = 0;
zI = 0;

const grid: Array<number[]> = [];
let row: number[];

for (let cI = minI; cI < maxI; cI += stepSizeI) {
	row = [];
	for (let cR = minR; cR < maxR; cR += stepSizeR) {
		row.push(determineStability(zR, zI, cR, cI));
	}
	grid.push(row);
}

writeDataToFile('mandelbrot', grid);

// ----------------


function determineStability(
	zR: number, zI: number,
	cR: number, cI: number,
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

	const dumR = zR ** 2 - zI ** 2 + cR;
	const dumI = 2 * zR * zI + cI;

	return determineStability(dumR, dumI, cR, cI, ++count);
}


