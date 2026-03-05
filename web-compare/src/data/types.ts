/** Binary mesh geometry (shared across scenarios). */
export interface MeshData {
  numVertices: number;
  numTriangles: number;
  bounds: { west: number; south: number; east: number; north: number };
  /** Interleaved [lng, lat, lng, lat, ...] */
  vertices: Float32Array;
  /** Triangle vertex indices [v0,v1,v2, v0,v1,v2, ...] */
  triangles: Uint32Array;
  /** Which cell each triangle belongs to */
  cellMap: Uint32Array;
}

/** Per-cell scalar values for one scenario+variable. */
export interface CellValues {
  numCells: number;
  nodata: number;
  values: Float32Array;
}

/** Scenario metadata from metadata.json */
export interface ScenarioMeta {
  file: string;
  variables: Record<string, { file: string; min: number; max: number }>;
}

export interface Metadata {
  bounds: [number, number, number, number];
  num_cells: number;
  nodata: number;
  scenarios: Record<string, ScenarioMeta>;
  variables: string[];
}

export type DisplayMode = 'a' | 'b' | 'diff';
