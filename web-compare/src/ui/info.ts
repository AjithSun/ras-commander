import type maplibregl from 'maplibre-gl';
import type { MeshData, CellValues, DisplayMode } from '../data/types';

/**
 * Simple grid-based spatial index for fast cell lookup on hover.
 */
export class CellInspector {
  private gridCols: number;
  private gridRows: number;
  private cellWidth: number;
  private cellHeight: number;
  private grid: Map<number, number[]>;
  private centers: Float64Array;
  private west: number;
  private south: number;
  private numCells: number;

  constructor(mesh: MeshData, cellCentersLngLat: Float64Array) {
    this.centers = cellCentersLngLat;
    this.numCells = cellCentersLngLat.length / 2;
    const { west, south, east, north } = mesh.bounds;
    this.west = west;
    this.south = south;

    // Grid resolution: ~100x100
    this.gridCols = 100;
    this.gridRows = 100;
    this.cellWidth = (east - west) / this.gridCols;
    this.cellHeight = (north - south) / this.gridRows;

    // Build spatial index
    this.grid = new Map();
    for (let i = 0; i < this.numCells; i++) {
      const lng = cellCentersLngLat[i * 2];
      const lat = cellCentersLngLat[i * 2 + 1];
      const col = Math.floor((lng - west) / this.cellWidth);
      const row = Math.floor((lat - south) / this.cellHeight);
      const key = row * this.gridCols + col;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key)!.push(i);
    }
  }

  findCell(lng: number, lat: number): number | null {
    const col = Math.floor((lng - this.west) / this.cellWidth);
    const row = Math.floor((lat - this.south) / this.cellHeight);

    // Search 3x3 neighborhood
    let bestDist = Infinity;
    let bestCell = -1;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const key = (row + dr) * this.gridCols + (col + dc);
        const cells = this.grid.get(key);
        if (!cells) continue;
        for (const ci of cells) {
          const clng = this.centers[ci * 2];
          const clat = this.centers[ci * 2 + 1];
          const d = (clng - lng) ** 2 + (clat - lat) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestCell = ci;
          }
        }
      }
    }

    return bestCell >= 0 ? bestCell : null;
  }
}

export function setupHoverInspector(
  map: maplibregl.Map,
  inspector: CellInspector,
  getValues: () => { a: CellValues | null; b: CellValues | null; mode: DisplayMode; nodata: number },
) {
  const infoText = document.getElementById('info-text')!;

  map.on('mousemove', (e) => {
    const { lng, lat } = e.lngLat;
    const cellId = inspector.findCell(lng, lat);

    if (cellId === null) {
      infoText.textContent = 'Hover over mesh to inspect';
      return;
    }

    const { a, b, mode, nodata } = getValues();

    const valA = a ? a.values[cellId] : NaN;
    const valB = b ? b.values[cellId] : NaN;
    const isNodataA = valA <= nodata + 0.5;
    const isNodataB = valB <= nodata + 0.5;
    const diff = (!isNodataA && !isNodataB) ? valB - valA : NaN;

    const fmtA = isNodataA ? 'N/A' : valA.toFixed(2);
    const fmtB = isNodataB ? 'N/A' : valB.toFixed(2);
    const fmtD = isNaN(diff) ? 'N/A' : (diff >= 0 ? '+' : '') + diff.toFixed(2);

    if (mode === 'diff') {
      infoText.innerHTML = `Cell ${cellId} | A: ${fmtA} | B: ${fmtB} | <b>Diff: ${fmtD}</b>`;
    } else if (mode === 'b') {
      infoText.innerHTML = `Cell ${cellId} | Value: <b>${fmtB}</b>`;
    } else {
      infoText.innerHTML = `Cell ${cellId} | Value: <b>${fmtA}</b>`;
    }
  });
}
