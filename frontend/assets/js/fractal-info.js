/* Shared fractal-info data + modal helper.
   Each entry: name, family, formula (LaTeX-ish), discoveredBy, year,
   dimension, history (HTML), importance (HTML), references (links).
   History/importance contain inline <a> tags — content is hand-authored
   and trusted, so the modal renders it via innerHTML.
   Used by the i-button on mandelbrot.html, fractal.html, game-of-life.html. */

// Shortcut helper for Wikipedia links (used heavily below).
const wp = (slug, label) => `<a href="https://en.wikipedia.org/wiki/${slug}" target="_blank" rel="noopener noreferrer">${label ?? slug.replace(/_/g, ' ')}</a>`;

window.FRACTAL_INFO = {
  mandelbrot: {
    name: 'Mandelbrot set',
    family: 'Escape-time complex dynamics',
    formula: 'z := z² + c · z₀ = 0 · M = { c ∈ ℂ : orbit stays bounded }',
    discoveredBy: `${wp('Robert_Brooks_(mathematician)', 'Robert Brooks')} &amp; Peter Matelski (1978); popularised by ${wp('Benoit_Mandelbrot', 'Benoit B. Mandelbrot')} (1980)`,
    year: 1980,
    dimension: `Boundary has ${wp('Hausdorff_dimension', 'Hausdorff dimension')} 2 (${wp('Mitsuhiro_Shishikura', 'Mitsuhiro Shishikura')}, 1991).`,
    history: [
      `The first computer-rendered image of M appeared in a <a href="https://www.ams.org/journals/proc/1981-082-04/S0002-9939-1981-0614897-8/" target="_blank" rel="noopener noreferrer">1978 paper</a> by Robert Brooks and Peter Matelski. ${wp('Benoit_Mandelbrot', 'Benoit Mandelbrot')} at IBM Watson generated higher-quality plots in 1980 and brought the set to wide attention through his 1982 book <em>${wp('The_Fractal_Geometry_of_Nature', 'The Fractal Geometry of Nature')}</em>.`,
      `In 1985, ${wp('Adrien_Douady', 'Adrien Douady')} and ${wp('John_H._Hubbard', 'John H. Hubbard')} proved M is connected, building the rigorous theory of polynomial dynamics. The "${wp('Mandelbrot_set#Local_connectivity', 'is the boundary locally connected?')}" question (MLC conjecture) remains a deep open problem in holomorphic dynamics.`,
    ],
    importance: [
      `The canonical fractal — a set whose boundary contains detail at every magnification. It is also the parameter-space "atlas" of the ${wp('Julia_set', 'Julia sets')}: K_c is connected if and only if c ∈ M, so picking c on the M-boundary picks the most visually rich Julia sets.`,
      `Inspired modern visualisation of chaos, the cultural concept of "fractals", and the entire deep-zoom rendering subculture: ${wp('Mandelbrot_set#Perturbation_theory', 'perturbation theory')}, reference orbits, and arbitrary-precision orbit search are all techniques developed to explore M past the limits of double-precision arithmetic.`,
    ],
    references: [
      { label: 'Mandelbrot set — Wikipedia', url: 'https://en.wikipedia.org/wiki/Mandelbrot_set' },
      { label: 'Brooks & Matelski (1978) — original paper', url: 'https://www.ams.org/journals/proc/1981-082-04/S0002-9939-1981-0614897-8/' },
      { label: 'Douady & Hubbard (1985) — Orsay notes on M (PDF)', url: 'https://pi.math.cornell.edu/~hubbard/OrsayEnglish.pdf' },
    ],
  },

  julia: {
    name: 'Julia set',
    family: 'Escape-time complex dynamics',
    formula: 'z := z² + c · c fixed · K_c = { z₀ ∈ ℂ : orbit stays bounded }',
    discoveredBy: `${wp('Gaston_Julia', 'Gaston Julia')} &amp; ${wp('Pierre_Fatou', 'Pierre Fatou')} (independently, c. 1918)`,
    year: 1918,
    dimension: 'Varies with c. For c on ∂M, often a fractal of dimension between 1 and 2.',
    history: [
      `${wp('Gaston_Julia', 'Gaston Julia')}, a French mathematician wounded at the Western Front in 1915, published <em>Mémoire sur l'itération des fonctions rationnelles</em> in 1918 — the same year ${wp('Pierre_Fatou', 'Pierre Fatou')} published independent results on the same topic. Their work on iteration of rational maps on the ${wp('Riemann_sphere', 'Riemann sphere')} won the French Academy of Sciences grand prize.`,
      `Visualisations had to wait until computer graphics caught up in the 1980s. Once Mandelbrot's set was known, the Julia "filled-in sets" were rendered by the thousands — one per c value — and people noticed the dictionary between local M-structure and Julia-set shape.`,
    ],
    importance: [
      `The mathematical dual of the ${wp('Mandelbrot_set', 'Mandelbrot set')}: M is the <em>parameter</em> space (one c, varying z₀), Julia sets are the <em>dynamical</em> space (varying c, all z₀). Together they form the foundation of ${wp('Complex_dynamics', 'holomorphic dynamics')}.`,
      `The boundary ∂K_c is where all the chaos lives — points there are dynamically sensitive, eventually wandering everywhere on the Julia set under iteration. Connected K_c (c ∈ M) gives spiraling "art" Julias; disconnected K_c (c ∉ M) gives Cantor-like "dust".`,
    ],
    references: [
      { label: 'Julia set — Wikipedia', url: 'https://en.wikipedia.org/wiki/Julia_set' },
      { label: 'Gaston Julia (1918) — Mémoire sur l\'itération', url: 'https://gallica.bnf.fr/ark:/12148/bpt6k3192q.image' },
      { label: 'Fatou & Julia — historical overview', url: 'https://www.mathcurve.com/courbes2d.gb/fatou/fatou.shtml' },
    ],
  },

  burning_ship: {
    name: 'Burning Ship fractal',
    family: 'Escape-time, non-holomorphic',
    formula: 'z := (|Re z| + i |Im z|)² + c · z₀ = 0',
    discoveredBy: `Michael Michelitsch &amp; ${wp('Otto_R%C3%B6ssler', 'Otto E. Rössler')}`,
    year: 1992,
    dimension: 'Not formally established — likely 2 on boundary, like Mandelbrot.',
    history: [
      `Michelitsch and Rössler introduced this iteration in 1992 as a variant of the Mandelbrot recurrence with absolute values applied to both components before squaring. The name comes from the "ship on fire" visual when the image is rendered upside-down: the main body resembles a burning galleon with rigging and antennas trailing into the sea.`,
      `Unlike the Mandelbrot iteration, the absolute value breaks holomorphy — the map is no longer complex-analytic, just real-piecewise-analytic. This makes the local geometry different in subtle and dramatic ways (notably the "fingers" and "antennas" along the real axis).`,
    ],
    importance: [
      `The most studied non-holomorphic deformation of the Mandelbrot iteration. Demonstrates that minor algebraic tweaks (here, abs() inside the square) produce dramatically different fractal geometry.`,
      `Embedded "mini-burnouts" appear at every scale, similar to M's mini-Mandelbrots but with the burning-ship outline. Distance estimators and smooth-coloring techniques have to be re-derived because they assumed holomorphy.`,
    ],
    references: [
      { label: 'Burning Ship fractal — Wikipedia', url: 'https://en.wikipedia.org/wiki/Burning_Ship_fractal' },
      { label: 'Michelitsch & Rössler (1992) — original short paper', url: 'https://www.sciencedirect.com/science/article/abs/pii/009784939290092B' },
    ],
  },

  mandelbulb: {
    name: 'Mandelbulb',
    family: 'Triplex (pseudo-3D) escape-time',
    formula: 'z := zⁿ + c (n = 8) using spherical-coordinate exponentiation',
    discoveredBy: 'Daniel White &amp; Paul Nylander',
    year: 2009,
    dimension: '~2.5 on boundary; bulk is locally 3D.',
    history: [
      `The Mandelbrot iteration doesn't naturally generalise to three dimensions — ${wp('Quaternion', 'quaternions')} give a smooth torus-shaped object, not a fractal. <a href="https://www.skytopia.com/project/fractal/2mandelbulb.html" target="_blank" rel="noopener noreferrer">Daniel White</a> began experimenting around 2007 with "triplex" algebra: a 3D analog using spherical coordinates (r, θ, φ) and a power rule "raise r to n, multiply θ and φ by n". Paul Nylander refined the formula and discovered the canonical n = 8 produces the most visually striking object.`,
      `The fractal art community on <a href="https://www.fractalforums.com/" target="_blank" rel="noopener noreferrer">Fractal Forums</a> (esp. Krzysztof Marczak, Subblue, and others) refined the renderer in 2009-2010 using ${wp('Distance_estimated_3D_fractals', 'distance-estimated raymarching')}, producing the iconic glossy "bulb" images.`,
    ],
    importance: [
      `First widely-accepted 3D analog of M — became iconic in math art and fractal visualisation. Strictly speaking, the underlying algebra isn't associative (so it isn't a true number system), making the Mandelbulb more of a procedural shape than a mathematical object — but the visuals are spectacular.`,
      `Drove the popularisation of distance-estimated raymarching, which has since become a standard technique for rendering implicit surfaces (used in everything from ${wp('Shadertoy', 'shadertoy')} art to procedural game worlds).`,
    ],
    references: [
      { label: 'Mandelbulb — Wikipedia', url: 'https://en.wikipedia.org/wiki/Mandelbulb' },
      { label: 'Daniel White — original "Mandelbulb" page', url: 'https://www.skytopia.com/project/fractal/2mandelbulb.html' },
      { label: 'Fractal Forums — Mandelbulb thread', url: 'https://fractalforums.com/3d-fractal-generation/' },
    ],
  },

  sierpinski: {
    name: 'Sierpiński triangle',
    family: 'Iterated function system (IFS)',
    formula: 'p := (p + Vᵢ) / 2 · Vᵢ ∈ {V₀, V₁, V₂} (chaos game)',
    discoveredBy: `${wp('Wac%C5%82aw_Sierpi%C5%84ski', 'Wacław Sierpiński')} (formalised in 1915); appears in 13th-c. ${wp('Cosmatesque', 'Cosmati pavements')}`,
    year: 1915,
    dimension: 'log 3 / log 2 ≈ 1.585',
    history: [
      `${wp('Wac%C5%82aw_Sierpi%C5%84ski', 'Wacław Sierpiński')}, a Polish mathematician, described the triangle in 1915 as an example of a self-similar curve with topological dimension less than 1. The same pattern appears centuries earlier in ${wp('Cosmatesque', 'Cosmati pavements')} at the Basilica of San Clemente, Rome (13th century) — a striking example of pre-mathematical fractal awareness.`,
      `The ${wp('Chaos_game', 'chaos game')} algorithm (pick a vertex at random, plot halfway, repeat) was popularised by ${wp('Michael_Barnsley', 'Michael Barnsley')} in the 1980s and remains the most elegant way to render the figure.`,
    ],
    importance: [
      `The simplest non-trivial ${wp('Iterated_function_system', 'IFS')} — three contractions of ratio 1/2 with equal probability. Used in classrooms as the introduction to self-similarity, IFS theory, and the surprising fact that random sampling converges to a deterministic shape.`,
      `Generalises in many directions: arbitrary-vertex chaos games (Sierpiński-like fractals from any polygon), 3D ${wp('Sierpi%C5%84ski_triangle#Generalization_to_other_modules', 'Sierpiński tetrahedron')}, and the Sierpiński carpet (2D analogue we use for the Menger sponge below).`,
    ],
    references: [
      { label: 'Sierpiński triangle — Wikipedia', url: 'https://en.wikipedia.org/wiki/Sierpi%C5%84ski_triangle' },
      { label: 'Chaos game — Wikipedia', url: 'https://en.wikipedia.org/wiki/Chaos_game' },
    ],
  },

  menger: {
    name: 'Menger sponge',
    family: 'Recursive subdivision',
    formula: 'Cube → 27 sub-cubes → remove the central cube and the 6 face-centre cubes. Repeat.',
    discoveredBy: wp('Karl_Menger', 'Karl Menger'),
    year: 1926,
    dimension: 'log 20 / log 3 ≈ 2.727',
    history: [
      `${wp('Karl_Menger', 'Karl Menger')}, an Austrian-American mathematician, introduced the sponge in 1926 as a 3D analogue of the ${wp('Sierpinski_carpet', 'Sierpiński carpet')}. He proved it is the "${wp('Menger_sponge#Universal_curve', 'universal curve')}" — every compact one-dimensional curve embeds into it.`,
      `The 2D cross-section (the Sierpiński carpet) is what we render here; the full 3D sponge requires raymarching. The structure shows up in topology, materials science (high surface-area structures), and architecture (compressed-volume aesthetics).`,
    ],
    importance: [
      `Topological universal curve — a small object containing topological copies of every "curve" in a generalised sense.`,
      `Despite the simple construction, every iteration removes exactly 20/27 of the volume → in the limit, volume goes to zero while surface area diverges. A canonical example of "infinite surface, zero volume" used in measure theory and fractal geometry teaching.`,
    ],
    references: [
      { label: 'Menger sponge — Wikipedia', url: 'https://en.wikipedia.org/wiki/Menger_sponge' },
      { label: 'Sierpiński carpet — Wikipedia', url: 'https://en.wikipedia.org/wiki/Sierpinski_carpet' },
    ],
  },

  koch: {
    name: 'Koch snowflake',
    family: 'L-system / line subdivision',
    formula: 'Axiom F++F++F · rule F → F-F++F-F · 60° turns',
    discoveredBy: wp('Helge_von_Koch', 'Helge von Koch'),
    year: 1904,
    dimension: 'log 4 / log 3 ≈ 1.262',
    history: [
      `${wp('Helge_von_Koch', 'Helge von Koch')}, a Swedish mathematician, introduced the curve in 1904 in a paper titled <em>Sur une courbe continue sans tangente, obtenue par une construction géométrique élémentaire</em>. He wanted to give an explicit construction (not just an existence proof) of a continuous-everywhere but differentiable-nowhere curve.`,
      `Predates Mandelbrot's "fractal" terminology by 70 years — the snowflake was one of the few well-known "monster" curves of early-20th-century analysis. Together with Cantor's set and ${wp('Peano_curve', 'Peano\'s curve')}, it formed the early vocabulary of pathological examples.`,
    ],
    importance: [
      `Earliest classic fractal — infinite perimeter enclosing finite area. A pillar of "pathological" continuous functions used to teach that intuition from smooth analysis breaks down for general continuous functions.`,
      `${wp('L-system', 'L-system')} construction shows how a tiny production rule (one character → six characters) compounds into a curve of arbitrarily high complexity — foundational to procedural generation in computer graphics and biology (${wp('Aristid_Lindenmayer', 'Lindenmayer')} systems for plant modelling).`,
    ],
    references: [
      { label: 'Koch snowflake — Wikipedia', url: 'https://en.wikipedia.org/wiki/Koch_snowflake' },
      { label: 'L-system — Wikipedia', url: 'https://en.wikipedia.org/wiki/L-system' },
    ],
  },

  cantor: {
    name: 'Cantor set',
    family: 'Recursive subdivision',
    formula: 'C₀ = [0, 1] · Cₙ₊₁ = Cₙ \\ (middle ⅓ of every component)',
    discoveredBy: `${wp('Georg_Cantor', 'Georg Cantor')} (1883); described earlier by ${wp('Henry_John_Stephen_Smith', 'Henry J. S. Smith')} (1875)`,
    year: 1883,
    dimension: 'log 2 / log 3 ≈ 0.631',
    history: [
      `${wp('Georg_Cantor', 'Georg Cantor')} introduced the set in 1883 as part of his foundational work on ${wp('Transfinite_number', 'transfinite numbers')} and topology of the real line. ${wp('Henry_John_Stephen_Smith', 'Henry Smith')} had described an essentially equivalent set in 1875 in an obscure paper, but Cantor's exposition is what entered the canon.`,
      `The set turned out to be a goldmine of "weird but true" properties — used by Cantor himself to demonstrate that uncountable sets need not be intervals, by ${wp('Henri_Lebesgue', 'Lebesgue')} to show measure-zero sets can be perfect, and by countless analysts since.`,
    ],
    importance: [
      `The first explicit fractal — uncountable, measure-zero, nowhere-dense, ${wp('Perfect_set', 'perfect')} (every point is a limit point), totally disconnected. A counterexample factory in real analysis and topology.`,
      `Cantor dust (its product with itself) and Cantor functions (the "${wp('Cantor_function', 'devil\'s staircase')}" built on it) form the building blocks of advanced calculus and probability counterexamples. Modern fractal geometry essentially started by generalising properties of this set.`,
    ],
    references: [
      { label: 'Cantor set — Wikipedia', url: 'https://en.wikipedia.org/wiki/Cantor_set' },
      { label: 'Cantor function (devil\'s staircase) — Wikipedia', url: 'https://en.wikipedia.org/wiki/Cantor_function' },
    ],
  },

  barnsley: {
    name: 'Barnsley fern',
    family: 'Iterated function system (IFS) with non-uniform probabilities',
    formula: 'p := Aᵢ p + bᵢ · four affine maps with weights 0.01, 0.85, 0.07, 0.07',
    discoveredBy: wp('Michael_Barnsley', 'Michael F. Barnsley'),
    year: 1988,
    dimension: '~1.8 (estimated)',
    history: [
      `${wp('Michael_Barnsley', 'Michael Barnsley')}, then at the Georgia Institute of Technology, introduced the fern in his 1988 book <em>Fractals Everywhere</em> as a striking demonstration that an ${wp('Iterated_function_system', 'IFS')} encodes natural-looking forms in just a handful of numbers. The four transforms (stem, leaflets, left fronds, right fronds) and their probabilities total 28 numbers.`,
      `Barnsley's "${wp('Collage_theorem', 'collage theorem')}" gave a constructive method for finding an IFS that approximates any image — sparking interest in ${wp('Fractal_compression', 'fractal image compression')} in the early 1990s (Iterated Systems Inc., his company, licensed the technology for early CD-ROM encyclopedias).`,
    ],
    importance: [
      `Visual proof that complex natural shapes (a recognisable fern) can be encoded extraordinarily compactly via IFS contractions. Foundational to ${wp('Fractal_compression', 'fractal-based image compression')} and procedural plant modelling in computer graphics.`,
      `Pedagogically, the canonical example showing that small changes to the affine coefficients produce dramatically different "ferns" — leaves, ivy, kelp, coral. Each is a stable fixed point of its own contraction system.`,
    ],
    references: [
      { label: 'Barnsley fern — Wikipedia', url: 'https://en.wikipedia.org/wiki/Barnsley_fern' },
      { label: 'Barnsley, Fractals Everywhere (1988) — book', url: 'https://www.elsevier.com/books/fractals-everywhere/barnsley/978-0-12-079062-3' },
    ],
  },

  dragon: {
    name: 'Heighway dragon curve',
    family: 'L-system / paper-folding',
    formula: 'Axiom F · rules F → F+G, G → F-G · 90° turns',
    discoveredBy: `John Heighway, Bruce Banks, William Harter (NASA physicists)`,
    year: 1967,
    dimension: '2 (space-filling without self-intersection)',
    history: [
      `Heighway, Banks, and Harter — three NASA physicists at the Goddard Spaceflight Center — discovered the curve in the early 1960s by folding paper strips in half repeatedly. When you unfold each crease to a right angle, the strip traces out the dragon. ${wp('Martin_Gardner', 'Martin Gardner')} introduced it to the general public in his March 1967 "${wp('Mathematical_Games_column', 'Mathematical Games')}" column in Scientific American.`,
      `The ${wp('L-system', 'L-system')} formulation came later from ${wp('Aristid_Lindenmayer', 'Aristid Lindenmayer')}'s grammar-based plant biology work in the 1970s. The dragon's self-similarity at scale 1/√2 and the curious "tiling the plane with one shape" property both turn it into a popular example in tiling theory.`,
    ],
    importance: [
      `A ${wp('Space-filling_curve', 'space-filling curve')} that does not self-intersect (though it gets arbitrarily close everywhere). Hausdorff dimension 2 — the entire plane is "almost" covered.`,
      `Two adjacent dragons tile a region; four dragons placed at right angles around a centre point tile the plane. Used as a textbook example of self-similar tilings and ${wp('Self-avoiding_walk', 'self-avoiding paths')}.`,
    ],
    references: [
      { label: 'Dragon curve — Wikipedia', url: 'https://en.wikipedia.org/wiki/Dragon_curve' },
      { label: 'Martin Gardner column on the dragon (1967)', url: 'https://en.wikipedia.org/wiki/Dragon_curve#History' },
    ],
  },

  lorenz: {
    name: 'Lorenz attractor',
    family: 'Continuous-time dynamical system (3 coupled ODEs)',
    formula: 'ẋ = σ(y − x) · ẏ = x(ρ − z) − y · ż = xy − βz · σ=10, ρ=28, β=8/3',
    discoveredBy: wp('Edward_Norton_Lorenz', 'Edward N. Lorenz'),
    year: 1963,
    dimension: '~2.06 (slightly above 2 — Lyapunov dimension)',
    history: [
      `${wp('Edward_Norton_Lorenz', 'Edward Lorenz')}, an MIT meteorologist, derived this 3-variable system in 1963 as a simplified model of atmospheric convection. While running simulations on a ${wp('Royal_McBee_LGP-30', 'Royal McBee LGP-30')}, he typed in rounded initial conditions (0.506 instead of 0.506127) and was startled when the trajectory diverged dramatically from his earlier run — leading to the discovery of sensitive dependence on initial conditions, which he later popularised as the "${wp('Butterfly_effect', 'butterfly effect')}" (1972 AAAS talk).`,
      `The double-lobed attractor, soon nicknamed the "butterfly" for its appearance and Lorenz's 1972 talk title, became the most-cited image in chaos theory. It took until 1999 (${wp('Warwick_Tucker', 'Warwick Tucker')}'s computer-assisted proof) to rigorously verify that the geometric Lorenz attractor really is a strange attractor.`,
    ],
    importance: [
      `Foundational example of ${wp('Chaos_theory', 'deterministic chaos')} — a system with simple, fully deterministic equations whose long-term behaviour is fundamentally unpredictable from finite-precision initial conditions.`,
      `Birthed ${wp('Chaos_theory', 'chaos theory')} as a recognised field, the popular-science "butterfly effect" framing, and decades of follow-up work on ${wp('Attractor#Strange_attractor', 'strange attractors')}, fractal basins of attraction, and the limits of weather prediction.`,
    ],
    references: [
      { label: 'Lorenz system — Wikipedia', url: 'https://en.wikipedia.org/wiki/Lorenz_system' },
      { label: 'Lorenz (1963) — Deterministic Nonperiodic Flow (PDF)', url: 'https://journals.ametsoc.org/view/journals/atsc/20/2/1520-0469_1963_020_0130_dnf_2_0_co_2.xml' },
      { label: 'Tucker (1999) — Lorenz Attractor Existence Proof', url: 'https://en.wikipedia.org/wiki/Tucker%27s_theorem' },
    ],
  },

  game_of_life: {
    name: "Conway's Game of Life",
    family: '2D cellular automaton',
    formula: 'B3 / S23 · Born with exactly 3 neighbours · Survive with 2 or 3 neighbours',
    discoveredBy: wp('John_Horton_Conway', 'John Horton Conway'),
    year: 1970,
    dimension: 'Discrete grid — not a fractal in the geometric sense',
    howItWorks: [
      `<strong>Setup.</strong> An infinite 2D square grid. Each cell is either <em>alive</em> or <em>dead</em>. The starting configuration (the "seed") is whatever you choose — a single ${wp('Glider_(Conway%27s_Game_of_Life)', 'glider')}, a random soup, a ${wp('Gun_(cellular_automaton)', 'glider gun')}, a hand-drawn shape. Time advances in discrete <em>generations</em>.`,
      `<strong>The rules.</strong> At every generation, every cell looks at its 8 neighbours (the ${wp('Moore_neighborhood', 'Moore neighbourhood')}) and decides its next state:`,
      `<ul>
        <li><b>Birth (B3):</b> a <em>dead</em> cell with <b>exactly 3</b> live neighbours becomes alive.</li>
        <li><b>Survival (S23):</b> a <em>live</em> cell with <b>2 or 3</b> live neighbours stays alive.</li>
        <li><b>Death:</b> any other live cell dies — <em>underpopulation</em> if it has fewer than 2 live neighbours, <em>overpopulation</em> if more than 3.</li>
      </ul>`,
      `<strong>Simultaneous update.</strong> Every cell computes its next state based on the <em>current</em> neighbour count; the whole grid then advances in lockstep. (Updating in-place — one cell at a time — gives a different and much less interesting cellular automaton.)`,
      `<strong>That's it.</strong> The notation <code>B3/S23</code> is shorthand: B = birth conditions, S = survival conditions. From these two tiny rules and nothing else, ${wp('Glider_(Conway%27s_Game_of_Life)', 'gliders')} skim across the grid, ${wp('Oscillator_(cellular_automaton)', 'oscillators')} pulse on fixed periods, ${wp('Spaceship_(cellular_automaton)', 'spaceships')} carry "data" around, and entire ${wp('Turing_machine', 'Turing machines')} can be assembled out of patterns. None of that is hard-coded anywhere — it's all emergent from B3/S23.`,
    ],
    history: [
      `${wp('John_Horton_Conway', 'John Conway')} invented Life at Cambridge in 1970, searching for a ${wp('Cellular_automaton', 'cellular automaton')} with rules that were as simple as possible yet capable of producing complex, unpredictable behaviour. He tested candidate rules manually on a ${wp('Go_(game)', 'Go')} board (he kept a notebook of patterns that died, exploded, or stabilised) and settled on B3/S23 as the simplest rule satisfying his criteria.`,
      `${wp('Martin_Gardner', 'Martin Gardner')} introduced it to a mass audience in his October 1970 "Mathematical Games" column. The following years produced an explosion of pattern discoveries: ${wp('Glider_(Conway%27s_Game_of_Life)', 'gliders')}, ${wp('Gun_(cellular_automaton)', 'glider guns')} (${wp('Bill_Gosper', 'Bill Gosper')}, 1970, claiming a $50 prize from Conway for proving Life can grow unboundedly), spaceships, oscillators, and eventually full-blown computational constructions.`,
    ],
    importance: [
      `${wp('Turing_completeness', 'Turing-complete')} — you can build any computation (and any pattern) inside Life. Famous constructions include a ${wp('Turing_machine', 'Turing machine')} (Paul Rendell), a programmable computer, even a Life-pattern that runs Life itself (the "${wp('OTCA_metapixel', 'OTCA metapixel')}").`,
      `Influential beyond mathematics: foundational to ${wp('Artificial_life', 'artificial life research')} (${wp('Christopher_Langton', 'Christopher Langton')}), inspiration for cellular automaton models in biology, urban planning, and crystal growth. The trio "simple rules + emergent complexity + universality" became a recurring motif in late-20th-century computer science.`,
    ],
    references: [
      { label: "Conway's Game of Life — Wikipedia", url: 'https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life' },
      { label: 'LifeWiki — community catalog of patterns', url: 'https://conwaylife.com/wiki/Main_Page' },
      { label: 'Gardner — October 1970 Scientific American column (scan)', url: 'https://web.stanford.edu/class/sts145/Library/life.pdf' },
    ],
  },
};

/* ---------- Modal helper ----------
   showFractalInfo(id) — opens an overlay dialog with the info for the given id.
   Builds the modal lazily on first call, then reuses the same DOM.
   Dismiss via close button, click on backdrop, or Escape key. */

function buildInfoModal() {
  const modal = document.createElement('div');
  modal.id = 'fractal-info-modal';
  modal.innerHTML = `
    <div class="fi-card" role="dialog" aria-modal="true" aria-labelledby="fi-title">
      <header class="fi-head">
        <h2 id="fi-title">—</h2>
        <button class="fi-close" type="button" aria-label="close">✕</button>
      </header>
      <div class="fi-body">
        <div class="fi-meta">
          <span class="fi-family">—</span>
          <span class="fi-sep">·</span>
          <span class="fi-credit">—</span>
        </div>
        <code class="fi-formula">—</code>
        <div class="fi-dim">—</div>
        <h3 class="fi-how-title">How it works</h3>
        <div class="fi-how"></div>
        <h3>History</h3>
        <div class="fi-history"></div>
        <h3>Why it matters</h3>
        <div class="fi-importance"></div>
        <h3 class="fi-refs-title">References</h3>
        <ul class="fi-refs"></ul>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // CSS injected once. Tokens come from colors_and_type.css which all pages
  // load already.
  const style = document.createElement('style');
  style.textContent = `
    #fractal-info-modal {
      position: fixed; inset: 0; z-index: 250;
      display: none; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      font-family: var(--font-sans);
    }
    #fractal-info-modal.active { display: flex; }
    #fractal-info-modal .fi-card {
      background: var(--ink-1);
      border: 1px solid var(--border);
      border-radius: 10px;
      max-width: 640px;
      width: calc(100vw - 48px);
      max-height: calc(100vh - 64px);
      display: flex; flex-direction: column;
      overflow: hidden;
      box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.8);
    }
    #fractal-info-modal .fi-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px;
      padding: 18px 22px 14px;
      border-bottom: 1px solid var(--border);
    }
    #fractal-info-modal h2 {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: -0.01em;
    }
    #fractal-info-modal .fi-close {
      appearance: none;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-subtle);
      width: 28px; height: 28px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      font-family: var(--font-mono);
      display: flex; align-items: center; justify-content: center;
      transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
    }
    #fractal-info-modal .fi-close:hover {
      background: var(--ink-2);
      color: var(--fg);
    }
    #fractal-info-modal .fi-body {
      padding: 18px 22px 22px;
      overflow-y: auto;
      color: var(--fg-muted);
      font-size: 14px;
      line-height: 1.55;
    }
    #fractal-info-modal .fi-meta {
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
      color: var(--fg-subtle);
      margin-bottom: 12px;
    }
    #fractal-info-modal .fi-meta .fi-family { color: var(--fg); }
    #fractal-info-modal .fi-sep { color: var(--fg-faint); margin: 0 6px; }
    #fractal-info-modal .fi-formula {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--accent);
      background: var(--ink-2);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      margin-bottom: 12px;
    }
    #fractal-info-modal .fi-dim {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--fg-subtle);
      margin-bottom: 18px;
      padding-bottom: 14px;
      border-bottom: 1px dashed var(--border);
    }
    #fractal-info-modal h3 {
      margin: 14px 0 6px;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--accent);
    }
    #fractal-info-modal h3:first-of-type { margin-top: 0; }
    #fractal-info-modal .fi-history p,
    #fractal-info-modal .fi-importance p,
    #fractal-info-modal .fi-how p {
      margin: 0 0 10px;
    }
    #fractal-info-modal .fi-history p:last-child,
    #fractal-info-modal .fi-importance p:last-child,
    #fractal-info-modal .fi-how p:last-child,
    #fractal-info-modal .fi-how ul:last-child {
      margin-bottom: 0;
    }
    #fractal-info-modal .fi-how ul {
      margin: 0 0 10px;
      padding: 0 0 0 20px;
    }
    #fractal-info-modal .fi-how li { margin: 0 0 4px; }
    #fractal-info-modal .fi-how code {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--accent);
      background: var(--ink-2);
      padding: 1px 5px;
      border-radius: 3px;
    }
    /* Inline links: accent colour, dashed underline that goes solid on hover.
       Visible at-a-glance but stay out of the body-text rhythm. */
    #fractal-info-modal a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dashed rgba(124, 255, 107, 0.45);
      transition: border-color var(--dur-fast) var(--ease-out),
                  color var(--dur-fast) var(--ease-out);
    }
    #fractal-info-modal a:hover {
      color: var(--accent-dim);
      border-bottom-color: var(--accent);
    }
    #fractal-info-modal .fi-refs {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    #fractal-info-modal .fi-refs li {
      margin: 0 0 4px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    #fractal-info-modal .fi-refs li::before {
      content: '↗';
      color: var(--accent);
      margin-right: 6px;
    }
  `;
  document.head.appendChild(style);

  // Event wiring
  const close = () => modal.classList.remove('active');
  modal.querySelector('.fi-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      e.stopPropagation(); close();
    }
  });

  return modal;
}

let _infoModal = null;

window.showFractalInfo = function showFractalInfo(id) {
  const info = window.FRACTAL_INFO[id];
  if (!info) {
    console.warn(`[fractal-info] no entry for id="${id}"`);
    return;
  }
  if (!_infoModal) _infoModal = buildInfoModal();
  _infoModal.querySelector('#fi-title').textContent = info.name;
  _infoModal.querySelector('.fi-family').textContent = info.family;
  // discoveredBy may now contain HTML (e.g. anchor tags) — render as innerHTML.
  _infoModal.querySelector('.fi-credit').innerHTML = `discovered by ${info.discoveredBy} · ${info.year}`;
  _infoModal.querySelector('.fi-formula').textContent = info.formula;
  _infoModal.querySelector('.fi-dim').innerHTML = info.dimension;
  // Optional "How it works" — rendered between dimension and history when present.
  // Entries without this field skip the section entirely (most fractals lean
  // on the formula + history to explain themselves).
  const howTitle = _infoModal.querySelector('.fi-how-title');
  const howEl    = _infoModal.querySelector('.fi-how');
  howEl.innerHTML = '';
  if (Array.isArray(info.howItWorks) && info.howItWorks.length > 0) {
    howTitle.style.display = '';
    howEl.style.display    = '';
    // Entries beginning with a block tag (<ul>, <ol>) are inserted as-is so
    // we don't end up with `<p><ul>…</ul></p>` (invalid — browsers silently
    // close the <p> before the <ul>, which is fine but messy).
    howEl.innerHTML = info.howItWorks
      .map(p => /^\s*<(ul|ol|div|table|pre)/i.test(p) ? p : `<p>${p}</p>`)
      .join('');
  } else {
    howTitle.style.display = 'none';
    howEl.style.display    = 'none';
  }
  const historyEl = _infoModal.querySelector('.fi-history');
  historyEl.innerHTML = '';
  for (const p of info.history) {
    const node = document.createElement('p');
    node.innerHTML = p;            // trusted hand-authored HTML
    historyEl.appendChild(node);
  }
  const importanceEl = _infoModal.querySelector('.fi-importance');
  importanceEl.innerHTML = '';
  for (const p of info.importance) {
    const node = document.createElement('p');
    node.innerHTML = p;
    importanceEl.appendChild(node);
  }
  // References block — hidden if the entry has no references.
  const refsTitle = _infoModal.querySelector('.fi-refs-title');
  const refsList  = _infoModal.querySelector('.fi-refs');
  refsList.innerHTML = '';
  if (Array.isArray(info.references) && info.references.length > 0) {
    refsTitle.style.display = '';
    refsList.style.display = '';
    for (const r of info.references) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = r.label;
      li.appendChild(a);
      refsList.appendChild(li);
    }
  } else {
    refsTitle.style.display = 'none';
    refsList.style.display = 'none';
  }
  _infoModal.classList.add('active');
  console.log(`[fractal-info] opened: ${id}`);
};
