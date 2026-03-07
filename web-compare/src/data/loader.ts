import type {
  Metadata,
  TemporalTile,
  TileCornerIndex,
  TileId,
} from './types';

const DATA_BASE = '/data';

export async function loadMetadata(): Promise<Metadata> {
  const resp = await fetch(`${DATA_BASE}/metadata.json`);
  if (!resp.ok) throw new Error(`Failed to load metadata: ${resp.status}`);
  const metadata = await resp.json() as Metadata;
  if (metadata.format !== 'temporal_tile_v1') {
    throw new Error(
      `Unsupported metadata format: ${String((metadata as { format?: unknown }).format)}`,
    );
  }
  return metadata;
}

export async function loadTileCornerIndex(metadata: Metadata): Promise<TileCornerIndex> {
  const file = metadata.tile_grid.tile_geometries_file;
  const resp = await fetch(`${DATA_BASE}/${file}`);
  if (!resp.ok) {
    throw new Error(`Failed to load tile geometry index ${file}: ${resp.status}`);
  }
  return resp.json() as Promise<TileCornerIndex>;
}

export function buildTileUrl(
  metadata: Metadata,
  scenario: string,
  variable: string,
  tileId: TileId,
): string {
  const scenarioMeta = metadata.scenarios[scenario];
  if (!scenarioMeta) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }
  const variableMeta = scenarioMeta.variables[variable];
  if (!variableMeta) {
    throw new Error(`Scenario ${scenario} has no variable ${variable}`);
  }

  const template = variableMeta.path_template;
  const path = template
    .replaceAll('{scenario}', scenario)
    .replaceAll('{variable}', variable)
    .replaceAll('{z}', String(tileId.z))
    .replaceAll('{x}', String(tileId.x))
    .replaceAll('{y}', String(tileId.y));

  if (path.startsWith('/')) {
    return `${DATA_BASE}${path}`;
  }
  return `${DATA_BASE}/${path}`;
}

export async function loadTemporalTile(url: string, tileId: TileId): Promise<TemporalTile | null> {
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Failed to load tile ${url}: ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const view = new DataView(buf);

  const headerBytes = 16;
  if (buf.byteLength < headerBytes) {
    throw new Error(`Temporal tile too small: ${url}`);
  }

  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const timesteps = view.getUint16(4, true);
  const flags = view.getUint16(6, true);
  const nodata = view.getFloat32(8, true);
  const dtHours = view.getFloat32(12, true);

  const valuesCount = width * height * timesteps;
  const isF16 = (flags & 1) === 1;
  const bytesPerValue = isF16 ? 2 : 4;
  const expectedBytes = headerBytes + valuesCount * bytesPerValue;
  const paddedExpectedBytes = isF16 ? expectedBytes + 2 : expectedBytes;

  if (buf.byteLength !== expectedBytes && buf.byteLength !== paddedExpectedBytes) {
    throw new Error(
      `Temporal tile payload mismatch for ${url}: expected ${expectedBytes}, got ${buf.byteLength}`,
    );
  }

  const valueType: TemporalTile['valueType'] = isF16 ? 'f16' : 'f32';
  const valuesF32 = isF16
    ? undefined
    : new Float32Array(buf, headerBytes, valuesCount);
  const valuesF16 = isF16
    ? new Uint16Array(buf, headerBytes, valuesCount)
    : undefined;

  return {
    id: tileId,
    width,
    height,
    timesteps,
    nodata,
    dtHours,
    valueType,
    valuesF32,
    valuesF16,
  };
}
