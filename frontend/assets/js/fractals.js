/* Fractal catalog — shared between the home page and the viewer.
   Lorenz attractor is intentionally omitted. */

const FRACTALS = [
  {
    id: 'mandelbrot', name: 'Mandelbrot set',
    image: 'assets/renders/whole.png',
    formula: 'z := z² + c',
    desc: 'The boundary of c-values for which z := z² + c stays bounded. The icon of complex dynamics — and the only one here with infinite zoom.',
    live: true,
    href: 'mandelbrot.html',
    kind: 'mandelbrot',
  },
  {
    id: 'julia', name: 'Julia set',
    image: 'assets/renders/julia.png',
    formula: 'z := z² + c · (c fixed)',
    desc: 'For each fixed c, the locus of starting z whose orbits never escape. A different shape for every c — shares the live WebGPU engine with Mandelbrot, infinite zoom included.',
    live: true,
    href: 'mandelbrot.html?kind=julia&jre=-0.38&jim=0.61',
    kind: 'escape-time',
    params: { kind: 'julia', cr: -0.7, ci: 0.27015, center: [0, 0], extent: 3.2 },
  },
  {
    id: 'burning_ship', name: 'Burning Ship',
    image: 'assets/renders/burning_ship.png',
    formula: 'z := (|re| + i|im|)² + c',
    desc: "Mandelbrot's recurrence with absolute values before squaring. The bend produces sails, masts, antennae.",
    kind: 'escape-time',
    params: { kind: 'burning_ship', center: [-0.5, -0.5], extent: 3.0 },
  },
  {
    id: 'mandelbulb', name: 'Mandelbulb',
    image: 'assets/renders/mandelbulb.png',
    formula: 'z := zⁿ + c · n = 8',
    desc: '3D analog of the Mandelbrot using spherical-coordinate exponentiation. Rendered here as a 2D z-slice through the bulb.',
    kind: 'escape-time',
    params: { kind: 'mandelbulb_slice', center: [0, 0], extent: 2.4 },
  },

  {
    id: 'sierpinski', name: 'Sierpiński triangle',
    image: 'assets/renders/sierpinski.png',
    formula: 'p := (p + Vᵢ) / 2',
    desc: 'Three vertices. Plot a point, jump halfway toward a random vertex, repeat half a million times.',
    kind: 'ifs',
    params: { kind: 'sierpinski', iterations: 600_000 },
  },
  {
    id: 'menger', name: 'Menger sponge',
    image: 'assets/renders/menger.png',
    formula: 'Mₙ₊₁ = ⨆ ⅓-cubes',
    desc: 'A cube minus its central cross, then the same removal applied to each remaining sub-cube. Rendered here as a 2D Sierpinski-carpet face.',
    kind: 'subdivision',
    params: { kind: 'menger', depth: 5 },
  },
  {
    id: 'koch', name: 'Koch snowflake',
    image: 'assets/renders/koch.png',
    formula: '─ → _∕\\_',
    desc: 'An equilateral triangle whose every edge sprouts smaller triangles. Infinite perimeter, finite area.',
    kind: 'lsystem',
    params: { kind: 'koch', depth: 5 },
  },
  {
    id: 'cantor', name: 'Cantor set',
    image: 'assets/renders/cantor.png',
    formula: 'Cₙ₊₁ = Cₙ \\ (middle ⅓)',
    desc: 'Take a line. Remove its middle third. Repeat on what is left. Nowhere dense but uncountable.',
    kind: 'subdivision',
    params: { kind: 'cantor', depth: 8 },
  },

  {
    id: 'barnsley', name: 'Barnsley fern',
    image: 'assets/renders/barnsley.png',
    formula: 'p := Aᵢ p + bᵢ',
    desc: 'Four affine transforms with weighted probabilities. Iterate, plot the orbit, and a leaf appears.',
    kind: 'ifs',
    params: { kind: 'barnsley', iterations: 400_000 },
  },
  {
    id: 'dragon', name: 'Dragon curve',
    image: 'assets/renders/dragon.png',
    formula: 'F → F+G, G → F−G',
    desc: 'Fold a strip of paper in half repeatedly, then unfold each crease to a right angle. The crease pattern.',
    kind: 'lsystem',
    params: { kind: 'dragon', depth: 13 },
  },
  {
    id: 'lorenz', name: 'Lorenz attractor',
    image: 'assets/renders/lorenz.png',
    formula: 'ẋ = σ(y−x) · ẏ = x(ρ−z)−y · ż = xy−βz',
    desc: 'Three coupled ODEs from atmospheric convection. Trajectories spiral around two centers but never repeat — projected here to the x-z plane.',
    kind: 'ode',
    params: { kind: 'lorenz' },
  },
  {
    id: 'game_of_life', name: "Conway's Game of Life",
    image: 'assets/renders/game_of_life.png',
    formula: 'B3 / S23',
    desc: 'A grid of cells. Live with 2–3 neighbours, born with exactly 3. Gliders, guns, and oscillators emerge.',
    live: true,
    href: 'game-of-life.html',
    kind: 'life',
  },
];

/* Palettes — used by the live escape-time renderers (Julia / Burning Ship /
   Mandelbulb slice). Each entry is an array of [stop, [r,g,b]] tuples.
   The IFS / L-system / subdivision renderers use a single accent color
   so palette selection there is presented but only swaps the accent. */
const PALETTES = {
  phosphor: {
    name: 'phosphor',
    swatch: 'linear-gradient(135deg,#003 0%,#7CFF6B 60%,#000 100%)',
    accent: [124, 255, 107],
    stops: [
      [0.00, [  0,   0,   0]],
      [0.25, [ 30,  90,  30]],
      [0.55, [124, 255, 107]],
      [0.78, [242, 240, 234]],
      [0.92, [ 30,  90,  30]],
      [1.00, [  0,   0,   0]],
    ],
  },
  warm: {
    name: 'warm',
    swatch: 'linear-gradient(135deg,#040a28 0%,#ffd28a 60%,#3a0000 100%)',
    accent: [255, 200, 110],
    stops: [
      [0.00, [  4,  10,  40]],
      [0.16, [ 15,  53, 110]],
      [0.42, [105, 209, 255]],
      [0.64, [255, 252, 210]],
      [0.86, [255, 138,  28]],
      [1.00, [ 50,   7,   0]],
    ],
  },
  ember: {
    name: 'ember',
    swatch: 'linear-gradient(135deg,#080200 0%,#FF3D14 60%,#F5C518 100%)',
    accent: [255, 90, 30],
    stops: [
      [0.00, [  8,   2,   0]],
      [0.30, [120,  20,   5]],
      [0.55, [255,  61,  20]],
      [0.78, [245, 197,  24]],
      [1.00, [  8,   2,   0]],
    ],
  },
  abyss: {
    name: 'abyss',
    swatch: 'linear-gradient(135deg,#03051A 0%,#193C8C 50%,#78B4FF 100%)',
    accent: [120, 180, 255],
    stops: [
      [0.00, [  3,   5,  18]],
      [0.40, [ 25,  60, 140]],
      [0.65, [120, 180, 255]],
      [0.85, [242, 240, 234]],
      [1.00, [  3,   5,  18]],
    ],
  },
  ivory: {
    name: 'ivory',
    swatch: 'linear-gradient(135deg,#000 0%,#F2F0EA 60%,#000 100%)',
    accent: [242, 240, 234],
    stops: [
      [0.00, [  0,   0,   0]],
      [0.50, [242, 240, 234]],
      [1.00, [  0,   0,   0]],
    ],
  },
};

window.FRACTALS = FRACTALS;
window.PALETTES = PALETTES;
