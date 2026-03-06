export interface TileVariableMeta {
  path_template: string;
  min: number;
  max: number;
}

export interface TileScenarioMeta {
  source_file: string;
  variables: Record<string, TileVariableMeta>;
}

export interface TileGrid {
  tile_size: number;
  min_zoom: number;
  max_zoom: number;
  full_width: number;
  full_height: number;
  bounds: [number, number, number, number];
  tile_geometries_file: string;
}

export interface Metadata {
  format: 'tile_grid_v1';
  nodata: number;
  tile_grid: TileGrid;
  scenarios: Record<string, TileScenarioMeta>;
  variables: string[];
}

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export interface FloatTile {
  id: TileId;
  width: number;
  height: number;
  nodata: number;
  values: Float32Array;
}

export interface TileCornerIndex {
  [tileKey: string]: [
    number, number,
    number, number,
    number, number,
    number, number,
  ];
}

export interface TileValueSample {
  valueA: number;
  valueB: number;
  diff: number;
  nodataA: boolean;
  nodataB: boolean;
}

export type DisplayMode = 'a' | 'b' | 'diff';
