import type maplibregl from 'maplibre-gl';
import { buildTileUrl, loadTemporalTile } from '../data/loader';
import type { Metadata, TemporalTile, TileCornerIndex, TileId } from '../data/types';

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileCorners {
  nw: [number, number];
  ne: [number, number];
  se: [number, number];
  sw: [number, number];
}

interface LevelShape {
  width: number;
  height: number;
  tilesX: number;
  tilesY: number;
  scale: number;
}

export class TileManager {
  private metadata: Metadata;
  private tileCornerIndex: TileCornerIndex;
  private maxCacheEntries: number;
  private tileCache = new Map<string, Promise<TemporalTile | null>>();

  constructor(
    metadata: Metadata,
    tileCornerIndex: TileCornerIndex,
    maxCacheEntries = 2000,
  ) {
    this.metadata = metadata;
    this.tileCornerIndex = tileCornerIndex;
    this.maxCacheEntries = maxCacheEntries;
  }

  clearCache(): void {
    this.tileCache.clear();
  }

  chooseZoomLevel(map: maplibregl.Map): number {
    const grid = this.metadata.tile_grid;
    const [west, south, east, north] = grid.bounds;
    const midLat = (south + north) / 2;

    const pWest = map.project([west, midLat]);
    const pEast = map.project([east, midLat]);
    const widthOnScreen = Math.max(1, Math.abs(pEast.x - pWest.x));
    const ratio = grid.full_width / widthOnScreen;
    const downsamplePow = this.clamp(
      Math.round(Math.log2(Math.max(1, ratio))),
      0,
      grid.max_zoom,
    );
    return this.clamp(grid.max_zoom - downsamplePow, grid.min_zoom, grid.max_zoom);
  }

  getVisibleTiles(map: maplibregl.Map, z: number, paddingTiles = 0): TileId[] {
    const bounds = map.getBounds();
    const grid = this.metadata.tile_grid;
    const shape = this.getLevelShape(z);
    const [modelWest, modelSouth, modelEast, modelNorth] = grid.bounds;

    const west = Math.max(bounds.getWest(), modelWest);
    const east = Math.min(bounds.getEast(), modelEast);
    const south = Math.max(bounds.getSouth(), modelSouth);
    const north = Math.min(bounds.getNorth(), modelNorth);
    if (west >= east || south >= north) return [];

    const topLeft = this.lngLatToLevelPixel(west, north, z);
    const bottomRight = this.lngLatToLevelPixel(east, south, z);
    if (!topLeft || !bottomRight) return [];

    const minPx = Math.min(topLeft.px, bottomRight.px);
    const maxPx = Math.max(topLeft.px, bottomRight.px);
    const minPy = Math.min(topLeft.py, bottomRight.py);
    const maxPy = Math.max(topLeft.py, bottomRight.py);

    const tileSize = grid.tile_size;
    let xMin = this.clamp(Math.floor(minPx / tileSize), 0, shape.tilesX - 1);
    let xMax = this.clamp(Math.floor((maxPx - 1e-6) / tileSize), 0, shape.tilesX - 1);
    let yMin = this.clamp(Math.floor(minPy / tileSize), 0, shape.tilesY - 1);
    let yMax = this.clamp(Math.floor((maxPy - 1e-6) / tileSize), 0, shape.tilesY - 1);

    if (paddingTiles > 0) {
      xMin = this.clamp(xMin - paddingTiles, 0, shape.tilesX - 1);
      xMax = this.clamp(xMax + paddingTiles, 0, shape.tilesX - 1);
      yMin = this.clamp(yMin - paddingTiles, 0, shape.tilesY - 1);
      yMax = this.clamp(yMax + paddingTiles, 0, shape.tilesY - 1);
    }

    const tiles: TileId[] = [];
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        tiles.push({ z, x, y });
      }
    }
    return tiles;
  }

  getTilePixelSize(id: TileId): { width: number; height: number } {
    const grid = this.metadata.tile_grid;
    const shape = this.getLevelShape(id.z);
    const x0 = id.x * grid.tile_size;
    const y0 = id.y * grid.tile_size;
    return {
      width: Math.max(1, Math.min(grid.tile_size, shape.width - x0)),
      height: Math.max(1, Math.min(grid.tile_size, shape.height - y0)),
    };
  }

  getTileCorners(id: TileId): TileCorners | null {
    const entry = this.tileCornerIndex[this.tileKey(id)];
    if (!entry) return null;
    return {
      nw: [entry[0], entry[1]],
      ne: [entry[2], entry[3]],
      se: [entry[4], entry[5]],
      sw: [entry[6], entry[7]],
    };
  }

  getTilePixelAtLngLat(
    lng: number,
    lat: number,
    z: number,
  ): { id: TileId; ix: number; iy: number } | null {
    const pos = this.lngLatToLevelPixel(lng, lat, z);
    if (!pos) return null;
    const grid = this.metadata.tile_grid;
    const shape = this.getLevelShape(z);
    const tileSize = grid.tile_size;

    const x = this.clamp(Math.floor(pos.px / tileSize), 0, shape.tilesX - 1);
    const y = this.clamp(Math.floor(pos.py / tileSize), 0, shape.tilesY - 1);
    const ix = this.clamp(Math.floor(pos.px - x * tileSize), 0, tileSize - 1);
    const iy = this.clamp(Math.floor(pos.py - y * tileSize), 0, tileSize - 1);
    return { id: { z, x, y }, ix, iy };
  }

  async getTile(
    scenario: string,
    variable: string,
    id: TileId,
  ): Promise<TemporalTile | null> {
    const key = `${scenario}|${variable}|${this.tileKey(id)}`;
    const cached = this.tileCache.get(key);
    if (cached) return cached;

    const url = buildTileUrl(this.metadata, scenario, variable, id);
    const loadPromise = loadTemporalTile(url, id);
    this.tileCache.set(key, loadPromise);
    this.pruneCache();
    return loadPromise;
  }

  private pruneCache(): void {
    while (this.tileCache.size > this.maxCacheEntries) {
      const oldest = this.tileCache.keys().next().value;
      if (!oldest) break;
      this.tileCache.delete(oldest);
    }
  }

  private tileKey(id: TileId): string {
    return `${id.z}/${id.x}/${id.y}`;
  }

  private getLevelShape(z: number): LevelShape {
    const grid = this.metadata.tile_grid;
    const scale = 2 ** (grid.max_zoom - z);
    const width = Math.ceil(grid.full_width / scale);
    const height = Math.ceil(grid.full_height / scale);
    const tilesX = Math.max(1, Math.ceil(width / grid.tile_size));
    const tilesY = Math.max(1, Math.ceil(height / grid.tile_size));
    return { width, height, tilesX, tilesY, scale };
  }

  private lngLatToLevelPixel(
    lng: number,
    lat: number,
    z: number,
  ): { px: number; py: number } | null {
    const grid = this.metadata.tile_grid;
    const [west, south, east, north] = grid.bounds;
    if (lng < west || lng > east || lat < south || lat > north) return null;

    const u = (lng - west) / (east - west);
    const v = (north - lat) / (north - south);
    const fullPx = u * grid.full_width;
    const fullPy = v * grid.full_height;

    const shape = this.getLevelShape(z);
    return {
      px: fullPx / shape.scale,
      py: fullPy / shape.scale,
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
