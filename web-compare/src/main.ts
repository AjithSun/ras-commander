import 'maplibre-gl/dist/maplibre-gl.css';
import { loadMetadata, loadMesh, loadCellValues } from './data/loader';
import type { CellValues, DisplayMode, Metadata } from './data/types';
import { initWebGPU } from './gpu/context';
import { createMeshBuffers, createValueBuffers, uploadCellValues } from './gpu/buffers';
import type { MeshBuffers, ValueBuffers } from './gpu/buffers';
import { createMap } from './map/map-setup';
import { createMeshLayer, type MeshLayerState } from './map/mesh-layer';
import { initControls, type ControlState } from './ui/controls';
import { updateLegend } from './ui/legend';
import { CellInspector, setupHoverInspector } from './ui/info';

const loading = document.getElementById('loading')!;

async function main() {
  // 1. Init WebGPU
  const gpu = await initWebGPU();
  if (!gpu.available) {
    loading.innerHTML = `<p style="color:red">${gpu.reason}</p>`;
    return;
  }
  const { device } = gpu;

  // 2. Load data
  const [metadata, mesh] = await Promise.all([loadMetadata(), loadMesh()]);

  // 3. Create GPU buffers
  const meshBuffers: MeshBuffers = createMeshBuffers(device, mesh);
  const valueBuffers: ValueBuffers = createValueBuffers(device, metadata.num_cells);

  // 4. Value cache
  const cache = new Map<string, CellValues>();
  async function getValues(scenario: string, variable: string): Promise<CellValues> {
    const key = `${scenario}_${variable}`;
    if (cache.has(key)) return cache.get(key)!;
    const meta = metadata.scenarios[scenario]?.variables[variable];
    if (!meta) throw new Error(`No data for ${key}`);
    const values = await loadCellValues(meta.file);
    cache.set(key, values);
    return values;
  }

  // 5. Mesh layer state
  const layerState: MeshLayerState = {
    mode: 'diff',
    valueMin: -5,
    valueMax: 5,
    opacity: 0.8,
    nodata: metadata.nodata,
    dirty: true,
  };

  // 6. Create map
  const map = createMap('map', mesh.bounds);

  // Track current values for hover inspector
  let currentValuesA: CellValues | null = null;
  let currentValuesB: CellValues | null = null;

  // 7. Apply scenario selection
  async function applyState(ctrl: ControlState) {
    const [valsA, valsB] = await Promise.all([
      getValues(ctrl.scenarioA, ctrl.variable),
      getValues(ctrl.scenarioB, ctrl.variable),
    ]);
    currentValuesA = valsA;
    currentValuesB = valsB;

    uploadCellValues(device, valueBuffers.valuesA, valsA);
    uploadCellValues(device, valueBuffers.valuesB, valsB);

    // Determine value range for coloring
    const metaA = metadata.scenarios[ctrl.scenarioA].variables[ctrl.variable];
    const metaB = metadata.scenarios[ctrl.scenarioB].variables[ctrl.variable];

    if (ctrl.mode === 'diff') {
      // For difference, use symmetric range
      const maxRange = Math.max(metaA.max - metaB.min, metaB.max - metaA.min, 2);
      const range = Math.min(maxRange, 10); // Cap at 10 for readability
      layerState.valueMin = -range;
      layerState.valueMax = range;
    } else if (ctrl.mode === 'b') {
      layerState.valueMin = metaB.min;
      layerState.valueMax = metaB.max;
    } else {
      layerState.valueMin = metaA.min;
      layerState.valueMax = metaA.max;
    }

    layerState.mode = ctrl.mode;
    layerState.opacity = ctrl.opacity;
    layerState.dirty = true;

    updateLegend(ctrl.mode, layerState.valueMin, layerState.valueMax, ctrl.variable);
    map.triggerRepaint();
  }

  // 8. Controls
  const initialState = initControls(metadata, async (state) => {
    await applyState(state);
  });

  // 9. Cell inspector for hover
  // Compute cell centers in WGS84 from mesh face points
  const cellCenters = computeCellCenters(mesh.vertices, mesh.triangles, mesh.cellMap, metadata.num_cells);
  const inspector = new CellInspector(mesh, cellCenters);

  // 10. Add layer once map loads
  map.on('load', async () => {
    map.addLayer(createMeshLayer(device, meshBuffers, valueBuffers, layerState));

    setupHoverInspector(map, inspector, () => ({
      a: currentValuesA,
      b: currentValuesB,
      mode: layerState.mode,
      nodata: metadata.nodata,
    }));

    // Initial data load
    await applyState(initialState);

    loading.classList.add('hidden');
  });
}

/** Compute approximate cell centers from triangle vertices and cell map. */
function computeCellCenters(
  vertices: Float32Array,
  triangles: Uint32Array,
  cellMap: Uint32Array,
  numCells: number,
): Float64Array {
  const sumLng = new Float64Array(numCells);
  const sumLat = new Float64Array(numCells);
  const counts = new Uint32Array(numCells);

  const numTris = cellMap.length;
  for (let t = 0; t < numTris; t++) {
    const cellId = cellMap[t];
    const i0 = triangles[t * 3];
    const i1 = triangles[t * 3 + 1];
    const i2 = triangles[t * 3 + 2];

    const lng = (vertices[i0 * 2] + vertices[i1 * 2] + vertices[i2 * 2]) / 3;
    const lat = (vertices[i0 * 2 + 1] + vertices[i1 * 2 + 1] + vertices[i2 * 2 + 1]) / 3;

    sumLng[cellId] += lng;
    sumLat[cellId] += lat;
    counts[cellId]++;
  }

  const centers = new Float64Array(numCells * 2);
  for (let i = 0; i < numCells; i++) {
    if (counts[i] > 0) {
      centers[i * 2] = sumLng[i] / counts[i];
      centers[i * 2 + 1] = sumLat[i] / counts[i];
    }
  }
  return centers;
}

main().catch(console.error);
