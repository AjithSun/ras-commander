import type maplibregl from 'maplibre-gl';
import type { DisplayMode, FloatTile, Metadata, TileId, TileValueSample } from '../data/types';
import { TileManager } from './tile-manager';

export interface TileOverlayState {
  scenarioA: string;
  scenarioB: string;
  variable: string;
  mode: DisplayMode;
  valueMin: number;
  valueMax: number;
  opacity: number;
}

interface TilePairRecord {
  id: TileId;
  a: FloatTile | null;
  b: FloatTile | null;
  loading: boolean;
  styleKey: string;
  canvas: HTMLCanvasElement | null;
  lastSeenTick: number;
}

interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const TILE_PREFETCH_PADDING = 4;
const PARENT_PREFETCH_PADDING = 2;

export class TileOverlayRenderer {
  private map: maplibregl.Map;
  private metadata: Metadata;
  private tileManager: TileManager;
  private state: TileOverlayState;

  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private tilePairs = new Map<string, TilePairRecord>();
  private currentLevel = 0;
  private devicePixelRatio = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private frameTick = 0;
  private disposed = false;

  constructor(
    map: maplibregl.Map,
    metadata: Metadata,
    tileManager: TileManager,
    initialState: TileOverlayState,
  ) {
    this.map = map;
    this.metadata = metadata;
    this.tileManager = tileManager;
    this.state = initialState;

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.top = '0';
    this.overlayCanvas.style.left = '0';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.zIndex = '5';

    const mapCanvas = map.getCanvas();
    mapCanvas.parentElement?.appendChild(this.overlayCanvas);

    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to initialize 2D overlay context');
    this.overlayCtx = ctx;
    this.syncCanvasSize();

    this.map.on('render', this.handleRender);
    this.map.on('remove', this.dispose);
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off('render', this.handleRender);
    this.map.off('remove', this.dispose);
    this.overlayCanvas.remove();
  };

  updateState(nextState: TileOverlayState): void {
    const scenarioChanged = (
      nextState.scenarioA !== this.state.scenarioA
      || nextState.scenarioB !== this.state.scenarioB
      || nextState.variable !== this.state.variable
    );
    this.state = nextState;
    if (scenarioChanged) {
      this.tilePairs.clear();
    } else {
      for (const record of this.tilePairs.values()) {
        record.styleKey = '';
      }
    }
    this.map.triggerRepaint();
  }

  sampleAtLngLat(lng: number, lat: number): TileValueSample | null {
    const pos = this.tileManager.getTilePixelAtLngLat(lng, lat, this.currentLevel);
    if (!pos) return null;
    const record = this.tilePairs.get(this.tileKey(pos.id));
    if (!record) return null;

    const width = record.a?.width ?? record.b?.width ?? 0;
    const height = record.a?.height ?? record.b?.height ?? 0;
    if (width <= 0 || height <= 0 || pos.ix >= width || pos.iy >= height) return null;
    const idx = pos.iy * width + pos.ix;

    const nodata = this.metadata.nodata;
    const valueA = record.a ? record.a.values[idx] : nodata;
    const valueB = record.b ? record.b.values[idx] : nodata;
    const nodataA = valueA <= nodata + 0.5;
    const nodataB = valueB <= nodata + 0.5;
    const diff = (!nodataA && !nodataB) ? valueB - valueA : nodata;
    return {
      valueA,
      valueB,
      diff,
      nodataA,
      nodataB,
    };
  }

  getVisibleDiffRange(percentile = 0.98): [number, number] | null {
    if (this.state.mode !== 'diff') return null;
    const visibleTiles = this.tileManager.getVisibleTiles(this.map, this.currentLevel);
    if (visibleTiles.length === 0) return null;

    const nodata = this.metadata.nodata;
    const absDiffs: number[] = [];

    for (const tile of visibleTiles) {
      const record = this.tilePairs.get(this.tileKey(tile));
      if (!record?.a || !record.b) continue;

      const valuesA = record.a.values;
      const valuesB = record.b.values;
      const count = Math.min(valuesA.length, valuesB.length);
      const stride = Math.max(1, Math.floor(count / 4000));

      for (let i = 0; i < count; i += stride) {
        const va = valuesA[i];
        const vb = valuesB[i];
        if (va <= nodata + 0.5 || vb <= nodata + 0.5) continue;
        absDiffs.push(Math.abs(vb - va));
      }
    }

    if (absDiffs.length < 32) return null;
    absDiffs.sort((a, b) => a - b);
    const idx = Math.floor(this.clamp(percentile, 0.5, 0.999) * (absDiffs.length - 1));
    const maxAbs = Math.max(absDiffs[idx], 0.05);
    return [-maxAbs, maxAbs];
  }

  private handleRender = (): void => {
    if (this.disposed) return;
    this.syncCanvasSize();
    this.overlayCtx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    this.overlayCtx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    this.currentLevel = this.tileManager.chooseZoomLevel(this.map);
    const drawTiles = this.tileManager.getVisibleTiles(this.map, this.currentLevel, 0);
    const loadTiles = this.tileManager.getVisibleTiles(
      this.map,
      this.currentLevel,
      TILE_PREFETCH_PADDING,
    );
    const parentLoadTiles = this.currentLevel > this.metadata.tile_grid.min_zoom
      ? this.tileManager.getVisibleTiles(
        this.map,
        this.currentLevel - 1,
        PARENT_PREFETCH_PADDING,
      )
      : [];
    this.frameTick++;
    const activeKeys = new Set<string>();

    for (const tile of loadTiles) {
      const record = this.queueTilePair(tile);
      activeKeys.add(this.tileKey(record.id));
    }

    for (const tile of parentLoadTiles) {
      const record = this.queueTilePair(tile);
      activeKeys.add(this.tileKey(record.id));
    }

    for (const tile of drawTiles) {
      const record = this.tilePairs.get(this.tileKey(tile));
      if (record && (record.a || record.b)) {
        this.drawTile(record);
      } else {
        this.drawParentFallback(tile);
      }
    }

    if (this.tilePairs.size > 5200) {
      const dropCandidates = Array.from(this.tilePairs.entries())
        .filter(([key]) => !activeKeys.has(key))
        .sort((a, b) => a[1].lastSeenTick - b[1].lastSeenTick);
      for (const [key] of dropCandidates) {
        if (this.tilePairs.size <= 4600) break;
        this.tilePairs.delete(key);
      }
    }
  };

  private queueTilePair(id: TileId): TilePairRecord {
    const key = this.tileKey(id);
    let record = this.tilePairs.get(key);
    if (!record) {
      record = {
        id,
        a: null,
        b: null,
        loading: true,
        styleKey: '',
        canvas: null,
        lastSeenTick: this.frameTick,
      };
      this.tilePairs.set(key, record);
      void this.loadTilePair(record);
    } else {
      record.lastSeenTick = this.frameTick;
    }
    return record;
  }

  private async loadTilePair(record: TilePairRecord): Promise<void> {
    try {
      const [a, b] = await Promise.all([
        this.tileManager.getTile(this.state.scenarioA, this.state.variable, record.id),
        this.tileManager.getTile(this.state.scenarioB, this.state.variable, record.id),
      ]);
      // If tile was evicted before load finished, ignore.
      const current = this.tilePairs.get(this.tileKey(record.id));
      if (!current) return;
      current.a = a;
      current.b = b;
      current.loading = false;
      current.styleKey = '';
      current.canvas = null;
      this.map.triggerRepaint();
    } catch (error) {
      console.error('Failed to load tile pair', record.id, error);
      const current = this.tilePairs.get(this.tileKey(record.id));
      if (current) current.loading = false;
    }
  }

  private drawTile(record: TilePairRecord): void {
    const canvas = this.getOrBuildTileCanvas(record);
    if (!canvas) return;
    const size = this.tileManager.getTilePixelSize(record.id);
    this.drawTileImage(record.id, canvas, size.width, size.height);
  }

  private drawParentFallback(childId: TileId): boolean {
    if (childId.z <= this.metadata.tile_grid.min_zoom) return false;

    let ancestorX = childId.x;
    let ancestorY = childId.y;

    for (let az = childId.z - 1; az >= this.metadata.tile_grid.min_zoom; az--) {
      ancestorX = Math.floor(ancestorX / 2);
      ancestorY = Math.floor(ancestorY / 2);
      const ancestorId: TileId = { z: az, x: ancestorX, y: ancestorY };
      const ancestorRecord = this.tilePairs.get(this.tileKey(ancestorId));
      if (!ancestorRecord) {
        if (az === childId.z - 1) {
          this.queueTilePair(ancestorId);
        }
        continue;
      }

      const ancestorCanvas = this.getOrBuildTileCanvas(ancestorRecord);
      if (!ancestorCanvas) continue;

      const levelDiff = childId.z - az;
      const factor = 2 ** levelDiff;
      const subX = childId.x - ancestorX * factor;
      const subY = childId.y - ancestorY * factor;

      const srcRect: SourceRect = {
        sx: (subX / factor) * ancestorCanvas.width,
        sy: (subY / factor) * ancestorCanvas.height,
        sw: ancestorCanvas.width / factor,
        sh: ancestorCanvas.height / factor,
      };

      const size = this.tileManager.getTilePixelSize(childId);
      this.drawTileImage(childId, ancestorCanvas, size.width, size.height, srcRect);
      return true;
    }

    return false;
  }

  private getOrBuildTileCanvas(record: TilePairRecord): HTMLCanvasElement | null {
    const styleKey = this.buildStyleKey();
    if (!record.canvas || record.styleKey !== styleKey) {
      record.canvas = this.buildTileCanvas(record.a, record.b);
      record.styleKey = styleKey;
    }
    return record.canvas;
  }

  private drawTileImage(
    tileId: TileId,
    image: HTMLCanvasElement,
    targetWidth: number,
    targetHeight: number,
    sourceRect?: SourceRect,
  ): void {
    const corners = this.tileManager.getTileCorners(tileId);
    if (!corners) return;

    const nw = this.map.project(corners.nw);
    const ne = this.map.project(corners.ne);
    const sw = this.map.project(corners.sw);

    const a = (ne.x - nw.x) / targetWidth;
    const b = (ne.y - nw.y) / targetWidth;
    const c = (sw.x - nw.x) / targetHeight;
    const d = (sw.y - nw.y) / targetHeight;
    const e = nw.x;
    const f = nw.y;

    this.overlayCtx.save();
    this.overlayCtx.transform(a, b, c, d, e, f);
    if (sourceRect) {
      this.overlayCtx.drawImage(
        image,
        sourceRect.sx,
        sourceRect.sy,
        sourceRect.sw,
        sourceRect.sh,
        0,
        0,
        targetWidth,
        targetHeight,
      );
    } else {
      this.overlayCtx.drawImage(image, 0, 0, targetWidth, targetHeight);
    }
    this.overlayCtx.restore();
  }

  private buildTileCanvas(
    tileA: FloatTile | null,
    tileB: FloatTile | null,
  ): HTMLCanvasElement | null {
    const tile = tileA ?? tileB;
    if (!tile) return null;
    const { width, height } = tile;
    const out = new Uint8ClampedArray(width * height * 4);
    const nodata = this.metadata.nodata;
    const range = this.state.valueMax - this.state.valueMin;
    const alphaByte = Math.round(this.state.opacity * 255);

    for (let i = 0; i < width * height; i++) {
      const va = tileA ? tileA.values[i] : nodata;
      const vb = tileB ? tileB.values[i] : nodata;
      const nodataA = va <= nodata + 0.5;
      const nodataB = vb <= nodata + 0.5;

      let value = nodata;
      let valid = false;
      if (this.state.mode === 'diff') {
        if (!nodataA && !nodataB) {
          value = vb - va;
          valid = true;
        }
      } else if (this.state.mode === 'b') {
        if (!nodataB) {
          value = vb;
          valid = true;
        }
      } else if (!nodataA) {
        value = va;
        valid = true;
      }

      const idx = i * 4;
      if (!valid || range <= 0) {
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 0;
        continue;
      }

      if (this.state.mode === 'diff') {
        const maxAbs = Math.max(Math.abs(this.state.valueMin), Math.abs(this.state.valueMax), 1e-6);
        const t = this.clamp((value + maxAbs) / (2 * maxAbs), 0, 1);
        const c = this.sampleDiverging(t);
        out[idx] = c[0];
        out[idx + 1] = c[1];
        out[idx + 2] = c[2];
        out[idx + 3] = alphaByte;
      } else {
        const t = this.clamp((value - this.state.valueMin) / range, 0, 1);
        const c = this.sampleSequential(t);
        out[idx] = c[0];
        out[idx + 1] = c[1];
        out[idx + 2] = c[2];
        out[idx + 3] = alphaByte;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = new ImageData(out, width, height);
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  private buildStyleKey(): string {
    return [
      this.state.scenarioA,
      this.state.scenarioB,
      this.state.variable,
      this.state.mode,
      this.state.valueMin.toFixed(5),
      this.state.valueMax.toFixed(5),
      this.state.opacity.toFixed(3),
    ].join('|');
  }

  private tileKey(id: TileId): string {
    return `${id.z}/${id.x}/${id.y}`;
  }

  private syncCanvasSize(): void {
    const container = this.map.getContainer();
    const cssWidth = Math.max(1, container.clientWidth);
    const cssHeight = Math.max(1, container.clientHeight);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);

    if (
      this.overlayCanvas.width !== pixelWidth
      || this.overlayCanvas.height !== pixelHeight
      || this.devicePixelRatio !== dpr
    ) {
      this.overlayCanvas.width = pixelWidth;
      this.overlayCanvas.height = pixelHeight;
      this.overlayCanvas.style.width = `${cssWidth}px`;
      this.overlayCanvas.style.height = `${cssHeight}px`;
      this.devicePixelRatio = dpr;
    }

    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
  }

  private sampleSequential(t: number): [number, number, number] {
    const stops: Array<[number, number, number]> = [
      [237, 245, 255],
      [107, 173, 215],
      [8, 48, 107],
    ];
    if (t <= 0.5) return this.mix(stops[0], stops[1], t * 2);
    return this.mix(stops[1], stops[2], (t - 0.5) * 2);
  }

  private sampleDiverging(t: number): [number, number, number] {
    const stops: Array<[number, number, number]> = [
      [30, 99, 176],
      [255, 255, 255],
      [214, 39, 40],
    ];
    if (t <= 0.5) return this.mix(stops[0], stops[1], t * 2);
    return this.mix(stops[1], stops[2], (t - 0.5) * 2);
  }

  private mix(
    a: [number, number, number],
    b: [number, number, number],
    t: number,
  ): [number, number, number] {
    const tt = this.clamp(t, 0, 1);
    return [
      Math.round(a[0] + (b[0] - a[0]) * tt),
      Math.round(a[1] + (b[1] - a[1]) * tt),
      Math.round(a[2] + (b[2] - a[2]) * tt),
    ];
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
