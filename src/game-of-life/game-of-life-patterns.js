/* Conway's Game of Life — curated pattern catalog.
   Patterns use '.' / 'O' ASCII grids. Centered automatically. */

const PATTERNS = [
  { id: 'soup',   name: 'Random soup',          kind: 'fill', density: 0.32,
    desc: '30% density across the grid — chaos that briefly orders itself.' },

  { id: 'empty',  name: 'Empty grid',           kind: 'fill', density: 0,
    desc: 'A clean slate. Draw cells with the mouse.' },

  { id: 'glider', name: 'Glider',               cells: [
    ".O.",
    "..O",
    "OOO"], desc: 'The smallest spaceship. Translates diagonally forever.' },

  { id: 'lwss',   name: 'Lightweight spaceship', cells: [
    ".OOOO",
    "O...O",
    "....O",
    "O..O."], desc: 'A 9-cell spaceship that glides horizontally.' },

  { id: 'gun',    name: 'Gosper glider gun',    cells: [
    "........................O...........",
    "......................O.O...........",
    "............OO......OO............OO",
    "...........O...O....OO............OO",
    "OO........O.....O...OO..............",
    "OO........O...O.OO....O.O...........",
    "..........O.....O.......O...........",
    "...........O...O....................",
    "............OO......................"],
    desc: 'The first known finite pattern with unbounded growth. Bill Gosper, 1970.' },

  { id: 'pulsar', name: 'Pulsar',               cells: [
    "..OOO...OOO..",
    ".............",
    "O....O.O....O",
    "O....O.O....O",
    "O....O.O....O",
    "..OOO...OOO..",
    ".............",
    "..OOO...OOO..",
    "O....O.O....O",
    "O....O.O....O",
    "O....O.O....O",
    ".............",
    "..OOO...OOO.."],
    desc: 'Period-3 oscillator with 48 living cells at peak.' },

  { id: 'penta',  name: 'Pentadecathlon',       cells: [
    "..O....O..",
    "OO.OOOO.OO",
    "..O....O.."],
    desc: 'A period-15 oscillator. Two blocks of 8 cells with a pulsing core.' },

  { id: 'acorn',  name: 'Acorn (methuselah)',   cells: [
    ".O.....",
    "...O...",
    "OO..OOO"],
    desc: '7 cells. Stabilises after 5,206 generations into 633 cells.' },

  { id: 'diehard', name: 'Diehard (methuselah)', cells: [
    "......O.",
    "OO......",
    ".O...OOO"],
    desc: '7 cells. Vanishes completely after exactly 130 generations.' },

  { id: 'rpent',  name: 'R-pentomino',          cells: [
    ".OO",
    "OO.",
    ".O."],
    desc: '5 cells. Runs for 1,103 generations before stabilising.' },

  { id: 'mixed',  name: 'Oscillator zoo',       compose: [
    { x: 4,  y: 4,  cells: ['OOO'] },                            // blinker
    { x: 4,  y: 12, cells: ['.OO', 'OO.', '.O.'] },              // r-pent
    { x: 12, y: 6,  cells: ['OO..', 'O.O.', '..O.', '..OO'] },   // toad-ish
    { x: 14, y: 14, cells: ['OO..', 'OO..', '..OO', '..OO'] },   // beacon
    { x: 24, y: 8,  cells: ['..O....O..', 'OO.OOOO.OO', '..O....O..'] }, // pentadecathlon
  ], desc: 'A small zoo of common oscillators next to each other.' },

  { id: 'infinite', name: 'Infinite growth',    cells: [
    "OOOOOOOO.OOOOO...OOO......OOOOOOO.OOOOO"],
    desc: 'A single row of 39 cells that produces unbounded growth.' },
];

Object.assign(window, { PATTERNS });
