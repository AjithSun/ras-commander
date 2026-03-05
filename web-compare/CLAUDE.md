# web-compare — WebGPU Flood Comparison Map

WebGPU-powered web map for comparing HEC-RAS 2D flood model results. Instantly toggles between scenarios and computes GPU-accelerated difference maps (red = water rose, blue = water fell).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Prepare data (requires Python with h5py, pyproj, numpy)
python scripts/prepare_data.py

# 3. Start data server + dev server
python scripts/serve.py &
npm run dev

# 4. Open http://localhost:5173 in Chrome 113+ (WebGPU required)
```

## Architecture

```
Python Pipeline (one-time)        Web App (runtime)
========================        ==================
HEC-RAS .p##.hdf                Load binary mesh bundle
    ↓ h5py + pyproj                 ↓
Binary .bin files               WebGPU storage buffers
    ↓ HTTP server                   ↓
Served on :8081                 Compute shader (difference)
                                    ↓
                                Render shader (colormap)
                                    ↓
                                Overlay canvas on MapLibre
```

### Key Design Decision: Overlay Canvas

The mesh is rendered by WebGPU directly to a transparent `<canvas>` overlaid on the MapLibre WebGL canvas (`pointer-events: none`). This avoids the expensive GPU→CPU→GPU readback that a CustomLayerInterface-only approach would require. MapLibre's `render()` callback provides the projection matrix; the overlay canvas provides the render target.

## Project Structure

```
web-compare/
├── scripts/
│   ├── prepare_data.py      # HDF → binary conversion (h5py, pyproj)
│   └── serve.py             # CORS HTTP server for data/ on :8081
├── src/
│   ├── main.ts              # Entry point, wires everything together
│   ├── data/
│   │   ├── types.ts         # TypeScript interfaces
│   │   └── loader.ts        # Fetch + parse binary files via DataView
│   ├── gpu/
│   │   ├── context.ts       # WebGPU adapter/device initialization
│   │   ├── buffers.ts       # GPU buffer creation and upload
│   │   ├── compute.ts       # Difference compute pipeline (B - A)
│   │   ├── render.ts        # Mesh render pipeline (instanced triangles)
│   │   └── shaders/
│   │       ├── mesh.wgsl    # Vertex (Mercator projection) + fragment (colormaps)
│   │       └── difference.wgsl  # Per-cell difference compute shader
│   ├── map/
│   │   ├── map-setup.ts     # MapLibre GL JS initialization
│   │   └── mesh-layer.ts    # CustomLayerInterface + overlay canvas
│   └── ui/
│       ├── controls.ts      # Scenario/variable/opacity controls
│       ├── legend.ts        # Dynamic color ramp legend
│       └── info.ts          # Hover cell inspector (grid spatial index)
├── data/                    # Generated binary files (gitignored)
├── public/style.css         # App styling
├── index.html               # App shell
├── vite.config.ts           # Vite config (WGSL imports, proxy)
├── tsconfig.json
└── package.json
```

## Data Pipeline

### Input

HEC-RAS HDF files with 2D unsteady results. Test data: `C:\Users\ajith\Documents\KDD_2D` (59,604 mesh cells, 4 scenarios).

### Binary Format

**`mesh.bin`** — shared geometry:
| Field | Type | Description |
|-------|------|-------------|
| numVertices | uint32 | Vertex count |
| numTriangles | uint32 | Triangle count |
| bounds | float64[4] | west, south, east, north (WGS84) |
| vertices | float32[N*2] | Interleaved [lng, lat, ...] |
| triangles | uint32[T*3] | Vertex indices per triangle |
| cellMap | uint32[T] | Triangle → cell ID mapping |

**`{scenario}_{variable}.bin`** — per-cell values:
| Field | Type | Description |
|-------|------|-------------|
| numCells | uint32 | Cell count |
| nodata | float32 | NoData sentinel (-9999) |
| values | float32[N] | One value per cell |

### Coordinate System

Source data is in EPSG:2278 (NAD83 TX South Central, US Survey Feet). The pipeline reprojects to EPSG:4326 (WGS84) for MapLibre. The WGSL vertex shader converts WGS84 to Web Mercator [0,1] for MapLibre's `mercatorMatrix`.

## GPU Pipeline

### Compute Stage (difference.wgsl)

Per-cell `diff[i] = B[i] - A[i]` with nodata handling. Dispatches `ceil(59604/256) = 233` workgroups. Runs only when scenario selection changes (dirty flag).

### Render Stage (mesh.wgsl)

**Instanced drawing**: 3 vertices per instance, `numTriangles` instances. Each instance looks up its vertex positions from the triangles/vertices storage buffers and its cell value from cell_map + cell_values.

**Vertex shader**: Converts lng/lat → Web Mercator → clip space via MapLibre's projection matrix.

**Fragment shader**: Two colormaps:
- **Sequential** (single scenario): light blue → dark blue ramp
- **Diverging** (difference): blue → white → red with alpha fade near zero

Output is premultiplied alpha for correct compositing on the overlay canvas.

### Blend Configuration

Canvas uses `alphaMode: 'premultiplied'`. Render pipeline uses `srcFactor: 'one', dstFactor: 'one-minus-src-alpha'`. Fragment shader outputs `vec4(color * alpha, alpha)`.

## Key Patterns

### Instanced Drawing

Cannot use standard indexed drawing because we need the triangle ID to look up which cell each triangle belongs to. Instead: `pass.draw(3, numTriangles)` with `@builtin(instance_index)` as triangle ID and `@builtin(vertex_index)` (0-2) as local vertex within triangle.

### Spatial Index for Hover

`CellInspector` builds a 100x100 grid over the model bounds. Each grid cell stores indices of mesh cells whose centers fall within it. On mousemove, searches the 3x3 neighborhood for nearest cell center. O(1) average lookup for 60K cells.

### Value Caching

Cell values are cached in a `Map<string, CellValues>` keyed by `{scenario}_{variable}`. Switching back to a previously loaded scenario is instant.

## Dependencies

**Runtime**: `maplibre-gl` (base map only — mesh rendering is pure WebGPU)

**Build**: `vite`, `typescript`, `@webgpu/types`

**Data pipeline**: `h5py`, `numpy`, `pyproj` (Python)

## Browser Requirements

WebGPU requires Chrome 113+ (or Edge 113+). Firefox and Safari have experimental support behind flags. The app shows a clear error message if WebGPU is unavailable.
