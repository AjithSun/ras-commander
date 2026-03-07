export type DisplayMode = 'a' | 'b' | 'diff';

export type MetricKind =
  | 'arrival'
  | 'peak_time'
  | 'time_to_peak'
  | 'duration_above_threshold';

export interface TemporalVariableMeta {
  path_template: string;
}

export interface TemporalScenarioMeta {
  plan_number: string;
  plan_title: string;
  variables: Record<string, TemporalVariableMeta>;
}

export interface TemporalInfo {
  timesteps: number;
  dt_hours: number;
  simulation_start_iso: string;
  simulation_duration_hours: number;
  threshold_default: number;
  value_dtype?: 'float32' | 'float16';
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
  format: 'temporal_tile_v1';
  nodata: number;
  temporal: TemporalInfo;
  tile_grid: TileGrid;
  variables: string[];
  metrics: MetricKind[];
  metric_ranges_hours: Record<MetricKind, [number, number]>;
  scenarios: Record<string, TemporalScenarioMeta>;
}

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export interface TemporalTile {
  id: TileId;
  width: number;
  height: number;
  timesteps: number;
  nodata: number;
  dtHours: number;
  valueType: 'f32' | 'f16';
  valuesF32?: Float32Array;
  valuesF16?: Uint16Array;
}

export interface TileCornerIndex {
  [tileKey: string]: [
    number, number,
    number, number,
    number, number,
    number, number,
  ];
}

export interface TileMetricSample {
  metricA: number;
  metricB: number;
  diff: number;
  nodataA: boolean;
  nodataB: boolean;
}
