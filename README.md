# Gerber Tool

A modern, browser-based Gerber file viewer and converter. This tool allows users to easily visualize printed circuit board (PCB) designs by dropping in Gerber and Drill files, interacting with the layout in a responsive canvas, and exporting the final consolidated image as a clean SVG.

## Features

- **Drag & Drop Interface:** Easily load individual `.gbr`, `.drl` files, or an entire `.zip` archive containing your PCB package.
- **Layer Management:** Automatically groups and colors layers based on type (copper, soldermask, silkscreen, etc.). Smart color shifting ensures multiple layers of the same type (e.g., front and back copper) are visually distinct via unique hues.
- **Interactive Viewer:** Pan, zoom, and inspect your boards directly in your browser.
- **Clean SVG Export:** Export your visualized board to a single SVG. The output is consolidated, meaning overlapping paths are merged into unified polygons rather than stacked shapes, resulting in small and clean files.

## Usage

1. **Load Files:** Drag and drop your Gerber files, NC Drill files, or a ZIP compilation of your project into the browser window, or use the "Browse" button.
2. **View and Inspect:** Use your mouse or trackpad to pan and zoom. You can toggle layer visibility using the sidebar to inspect specific layers like soldermask or silkscreen.
3. **Export:** Click the "Export SVG" button to download a scalable vector graphics file of the currently visible layers.

---

## Developer Details

This project is built using **TypeScript**, **Vite**, and **d3-contour**. It leverages the `tracespace` ecosystem (`@tracespace/parser`, `@tracespace/plotter`, `@tracespace/renderer`) for interpreting the Gerber format specifications and rendering the raw primitives.

### How it Works

The application architecture revolves around a central state that tracks parsed layers and calculates a global bounding box.

1. **Parsing (`processGerberText`)**  
   Files are read as text and passed into the `tracespace` parser. The resulting AST is transformed into an image tree by the plotter. This tree is then rendered into an SVG HTML string (hast). A custom parser is optionally used for specific drill formats before falling back to `tracespace`. 

2. **AST Patching & Fallback rendering**  
   To align `@tracespace/parser@next` with `@tracespace/plotter@alpha`, an AST monkey-patch step resolves mapping issues between macro shapes, primitive parameters, and modifiers. If `tracespace`'s plotter throws an exception—which generally happens if it encounters unsupported macros—the tool gracefully detects and strips out the problematic references, then retries.

### Rasterize-Vectorize Pass (Clean SVG Export)

A standout feature is the SVG export pipeline. The raw SVG output from gerbers can contain thousands of overlapping raw strokes that bloat the exported file and create visual artifacts in downstream tools.

To alleviate this, the tool implements a **Rasterize-Vectorize pass** (`exportSvg`):
   
1. **Rasterization:**  
   For each visible layer, the SVG is injected into a synthetic DOM tree and all fills and strokes are overridden to solid black (`#000000`). It is then serialized to an image, scaled at 80 pixels per mm (an arbitrary, high-fidelity resolution), and rasterized onto a headless highly performant HTML Canvas to grab the full image data.
   
2. **Marching Squares (Contour Extraction):**  
   The image's alpha channel (0-255) is extracted from the pixel buffer. This one-dimensional array is passed into `d3-contour`. It thresholds the array at an alpha of `128` (50% opacity) and applies the marching squares algorithm to calculate a GeoJSON-like list of boundaries and holes (contours).
   
3. **Vectorization:**  
   The extracted pixel-coordinates of the contours are scaled backward down to native millimeter dimensions, translated by the global bounding box offsets. Finally, `geoJsonToSvgPath` builds optimal SVG `M...L...Z` path strings for these MultiPolygons.

This process eliminates millions of internal vertices, giving you single, homogeneous paths for each PCB layer, significantly reducing SVG bloat and guaranteeing correct union geometries.
