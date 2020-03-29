# Fractals
Experimenting with fractals and infinite zooming!

## Setup

    $> yarn

or

    $> npm i

and start the development server

    $> yarn serve

or

    $> npm run serve

and point you browser to http://localhost:3000

# Mandelbrot

## Theory

𝑓(𝑧) = 𝑧 <sup>2</sup> + 𝑐

z<sub>n + 1</sub> = z <sup>2</sup><sub>n</sub> + c 

-- 

1) 𝑧 <sub>0</sub> = 0
2) 𝑧 <sub>1</sub> = 𝑧 <sub>0</sub> + 𝑐
3) 𝑧 <sub>2</sub> = 𝑧 <sub>1</sub> + 𝑐
4) etc

with 𝑐 the point in the complex plain where we plot the outcome of the calculation

## Generate data

    $> yarn mandelbrot

Data is now visible at http://localhost:3000/mandelbrot

# Julia set

The Julia Set is idential to the Mandelbrot except that `c` is now some fixed point 
and z<sub>0</sub> is the place where the computation is plotted

# Infinite zooming

todo

# Bookmarks

   * Infinite zoom theory: http://www.science.eclipse.co.uk/sft_maths.pdf
   * Basics: https://www.youtube.com/watch?v=FFftmWSzgmk 
   * Approximate PI with Mandelbrot: https://www.youtube.com/watch?v=d0vY0CKYhPY&t=4s

