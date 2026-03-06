import type { FloatTile, Metadata, TileCornerIndex, TileId } from './types';

const DATA_BASE = '/data';

export async function loadMetadata(): Promise<Metadata> {
  const resp = await fetch(`${DATA_BASE}/metadata.json`);
  if (!resp.ok) throw new Error(`Failed to load metadata: ${resp.status}`);
  const metadata = await resp.json() as Metadata;
  if (metadata.format !== 'tile_grid_v1') {
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

export async function loadFloatTile(url: string, tileId: TileId): Promise<FloatTile | null> {
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Failed to load tile ${url}: ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const view = new DataView(buf);

  if (buf.byteLength < 8) {
    throw new Error(`Tile too small: ${url}`);
  }
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const nodata = view.getFloat32(4, true);
  const expectedFloats = width * height;
  const expectedBytes = 8 + expectedFloats * 4;
  if (buf.byteLength !== expectedBytes) {
    throw new Error(
      `Tile payload mismatch for ${url}: expected ${expectedBytes}, got ${buf.byteLength}`,
    );
  }
  const values = new Float32Array(buf, 8, expectedFloats);
  return {
    id: tileId,
    width,
    height,
    nodata,
    values,
  };
}
