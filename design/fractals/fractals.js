/* Fractal catalog — shared between Home.html and Fractal.html */

const FRACTALS = [
  {
    id: 'mandelbrot', name: 'Mandelbrot set',
    image: 'renders/whole.png',
    formula: 'z := z² + c',
    desc: 'The boundary of c-values for which the iteration z := z² + c stays bounded. The icon of complex dynamics.',
    live: true,
    href: 'Mandelbrot.html',
    palette: true,
  },
  {
    id: 'julia', name: 'Julia set',
    image: 'renders/julia.png',
    formula: 'z := z² + c · (c fixed)',
    desc: 'For each fixed c, the locus of starting z whose orbits never escape. A different shape for every c.',
    palette: true,
  },
  {
    id: 'burning_ship', name: 'Burning Ship',
    image: 'renders/burning_ship.png',
    formula: 'z := (|re| + i|im|)² + c',
    desc: "Mandelbrot's recurrence with absolute values before squaring. The bend produces sails, masts, antennae.",
    palette: true,
  },
  {
    id: 'mandelbulb', name: 'Mandelbulb',
    image: 'renders/mandelbulb.png',
    formula: 'z := zⁿ + c · n = 8',
    desc: 'A 3D analog of the Mandelbrot using spherical-coordinate exponentiation. Power 8 is canonical.',
    palette: true,
  },

  {
    id: 'sierpinski', name: 'Sierpiński triangle',
    image: 'renders/sierpinski.png',
    formula: 'p := (p + Vᵢ) / 2',
    desc: 'Three vertices. Plot a point, jump halfway toward a random vertex, repeat half a million times.',
  },
  {
    id: 'menger', name: 'Menger sponge',
    image: 'renders/menger.png',
    formula: 'Mₙ₊₁ = ⨆ ⅓-cubes',
    desc: 'A cube minus its central cross, then the same removal applied to each remaining sub-cube. Forever.',
  },
  {
    id: 'koch', name: 'Koch snowflake',
    image: 'renders/koch.png',
    formula: '─ → _∕\\_',
    desc: 'An equilateral triangle whose every edge sprouts smaller triangles. Infinite perimeter, finite area.',
  },
  {
    id: 'cantor', name: 'Cantor set',
    image: 'renders/cantor.png',
    formula: 'Cₙ₊₁ = Cₙ \\ (middle ⅓)',
    desc: 'Take a line. Remove its middle third. Repeat on what is left. The result is nowhere dense but uncountable.',
  },

  {
    id: 'barnsley', name: 'Barnsley fern',
    image: 'renders/barnsley.png',
    formula: 'p := Aᵢ p + bᵢ',
    desc: 'Four affine transforms with weighted probabilities. Iterate, plot the orbit, and a leaf appears.',
  },
  {
    id: 'dragon', name: 'Dragon curve',
    image: 'renders/dragon.png',
    formula: 'F → F+G, G → F−G',
    desc: 'Fold a strip of paper in half repeatedly, then unfold each crease to a right angle. The crease pattern.',
  },
  {
    id: 'game_of_life', name: "Conway's Game of Life",
    image: 'renders/game_of_life.png',
    formula: 'B3 / S23',
    desc: 'A grid of cells. Live with 2–3 neighbours, born with exactly 3. Gliders, guns, and oscillators emerge.',
    live: true,
    href: 'GameOfLife.html',
  },
  {
    id: 'lorenz', name: 'Lorenz attractor',
    image: 'renders/lorenz.png',
    formula: 'ẋ = σ(y−x) · ẏ = x(ρ−z)−y · ż = xy−βz',
    desc: 'Three coupled ODEs from atmospheric convection. Trajectories spiral around two centers but never repeat.',
  },
];

// CSS-filter palettes for the static viewers — visually swap palettes
// without re-rendering.
const FILTER_PALETTES = [
  { id: 'orig',     name: 'original',  filter: 'none',
                    swatch: 'linear-gradient(135deg,#f2f0ea 0%,#7CFF6B 50%,#0A0A0A 100%)' },
  { id: 'phosphor', name: 'phosphor',  filter: 'sepia(0.3) hue-rotate(60deg) saturate(1.8) brightness(1.05)',
                    swatch: 'linear-gradient(135deg,#003 0%,#7CFF6B 60%,#000 100%)' },
  { id: 'ember',    name: 'ember',     filter: 'sepia(0.4) hue-rotate(-30deg) saturate(1.7) brightness(1.0)',
                    swatch: 'linear-gradient(135deg,#080200 0%,#FF3D14 60%,#F5C518 100%)' },
  { id: 'abyss',    name: 'abyss',     filter: 'hue-rotate(200deg) saturate(1.3) brightness(0.95)',
                    swatch: 'linear-gradient(135deg,#03051A 0%,#193C8C 50%,#78B4FF 100%)' },
  { id: 'ivory',    name: 'ivory',     filter: 'grayscale(0.9) contrast(1.15) brightness(1.05)',
                    swatch: 'linear-gradient(135deg,#000 0%,#F2F0EA 60%,#000 100%)' },
];

Object.assign(window, { FRACTALS, FILTER_PALETTES });
