import type { MeshData, CellValues, Metadata } from './types';

const DATA_BASE = '/data';

export async function loadMetadata(): Promise<Metadata> {
  const resp = await fetch(`${DATA_BASE}/metadata.json`);
  if (!resp.ok) throw new Error(`Failed to load metadata: ${resp.status}`);
  return resp.json();
}

export async function loadMesh(): Promise<MeshData> {
  const resp = await fetch(`${DATA_BASE}/mesh.bin`);
  if (!resp.ok) throw new Error(`Failed to load mesh.bin: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const view = new DataView(buf);

  let offset = 0;
  const numVertices = view.getUint32(offset, true); offset += 4;
  const numTriangles = view.getUint32(offset, true); offset += 4;
  const west = view.getFloat64(offset, true); offset += 8;
  const south = view.getFloat64(offset, true); offset += 8;
  const east = view.getFloat64(offset, true); offset += 8;
  const north = view.getFloat64(offset, true); offset += 8;

  const vertBytes = numVertices * 2 * 4;
  const vertices = new Float32Array(buf, offset, numVertices * 2); offset += vertBytes;

  const triBytes = numTriangles * 3 * 4;
  const triangles = new Uint32Array(buf, offset, numTriangles * 3); offset += triBytes;

  const cellMap = new Uint32Array(buf, offset, numTriangles);

  return {
    numVertices, numTriangles,
    bounds: { west, south, east, north },
    vertices, triangles, cellMap,
  };
}

export async function loadCellValues(filename: string): Promise<CellValues> {
  const resp = await fetch(`${DATA_BASE}/${filename}`);
  if (!resp.ok) throw new Error(`Failed to load ${filename}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const view = new DataView(buf);

  const numCells = view.getUint32(0, true);
  const nodata = view.getFloat32(4, true);
  const values = new Float32Array(buf, 8, numCells);

  return { numCells, nodata, values };
}
