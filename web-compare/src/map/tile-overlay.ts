import type maplibregl from 'maplibre-gl';
import type {
  DisplayMode,
  Metadata,
  MetricKind,
  TemporalTile,
  TileId,
  TileMetricSample,
} from '../data/types';
import { initGpuContext, type GpuContext } from '../gpu/context';
import metricShader from '../gpu/shaders/metric.wgsl?raw';
import metricShaderF16 from '../gpu/shaders/metric_f16.wgsl?raw';
import tileShader from '../gpu/shaders/tile.wgsl?raw';
import { TileManager } from './tile-manager';

export interface TileOverlayState {
  scenarioA: string;
  scenarioB: string;
  variable: string;
  metric: MetricKind;
  mode: DisplayMode;
  threshold: number;
  valueMin: number;
  valueMax: number;
  opacity: number;
}

interface TileGpuResources {
  width: number;
  height: number;
  timesteps: number;
  bufferA: GPUBuffer;
  bufferB: GPUBuffer;
  paramsBuffer: GPUBuffer;
  metricTexture: GPUTexture;
  metricView: GPUTextureView;
  computeBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
}

interface TilePairRecord {
  id: TileId;
  a: TemporalTile | null;
  b: TemporalTile | null;
  loading: boolean;
  lastSeenTick: number;
  gpu: TileGpuResources | null;
  computedKey: string;
}

interface DrawEntry {
  bindGroup: GPUBindGroup;
  firstVertex: number;
}

const TILE_PREFETCH_PADDING = 3;
const MIN_WORKGROUP_SIZE = 8;
const TARGET_WORKGROUP_SIZE = 16;

export class TileOverlayRenderer {
  private map: maplibregl.Map;
  private metadata: Metadata;
  private tileManager: TileManager;
  private state: TileOverlayState;

  private overlayCanvas: HTMLCanvasElement;
  private tilePairs = new Map<string, TilePairRecord>();
  private currentLevel = 0;
  private frameTick = 0;
  private devicePixelRatio = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  private disposed = false;

  private gpu: GpuContext | null = null;
  private computePipeline: GPUComputePipeline | null = null;
  private computeUsesF16 = false;
  private workgroupX = MIN_WORKGROUP_SIZE;
  private workgroupY = MIN_WORKGROUP_SIZE;
  private renderPipeline: GPURenderPipeline | null = null;
  private styleBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexBufferSize = 0;
  private ready = false;

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
    map.getCanvas().parentElement?.appendChild(this.overlayCanvas);
    this.syncCanvasSize();

    this.map.on('render', this.handleRender);
    this.map.on('remove', this.dispose);
    void this.initGpu().catch((error) => {
      console.error('WebGPU initialization failed', error);
      const loading = document.getElementById('loading');
      if (loading) {
        loading.classList.remove('hidden');
        loading.innerHTML = `<p style="max-width:420px;text-align:center;padding:20px">
          WebGPU is required and failed to initialize.
        </p>`;
      }
    });
  }

  private async initGpu(): Promise<void> {
    this.gpu = await initGpuContext(this.overlayCanvas);
    const { device, format } = this.gpu;
    const [wgX, wgY] = this.chooseWorkgroupSize();
    this.workgroupX = wgX;
    this.workgroupY = wgY;
    this.computeUsesF16 = (
      this.gpu.supportsShaderF16
      && this.metadata.temporal.value_dtype === 'float16'
    );
    if (
      this.metadata.temporal.value_dtype === 'float16'
      && !this.computeUsesF16
    ) {
      console.warn(
        'float16 tiles loaded but shader-f16 is unavailable; converting to float32 on upload.',
      );
    }

    this.computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          code: this.computeUsesF16 ? metricShaderF16 : metricShader,
        }),
        entryPoint: 'main',
        constants: {
          WG_X: this.workgroupX,
          WG_Y: this.workgroupY,
        },
      },
    });

    this.renderPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: tileShader }),
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: tileShader }),
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
            writeMask: GPUColorWrite.ALL,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.styleBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    console.info(
      `WebGPU metric pipeline: ${this.computeUsesF16 ? 'f16' : 'f32'}, `
      + `workgroup=${this.workgroupX}x${this.workgroupY}`,
    );

    this.ready = true;
    this.map.triggerRepaint();
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off('render', this.handleRender);
    this.map.off('remove', this.dispose);
    this.overlayCanvas.remove();
    this.clearTilePairs();
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = null;
      this.vertexBufferSize = 0;
    }
  };

  updateState(nextState: TileOverlayState): void {
    const scenarioChanged = (
      nextState.scenarioA !== this.state.scenarioA
      || nextState.scenarioB !== this.state.scenarioB
      || nextState.variable !== this.state.variable
    );
    this.state = nextState;
    if (scenarioChanged) {
      this.clearTilePairs();
      this.tileManager.clearCache();
    } else {
      for (const rec of this.tilePairs.values()) {
        rec.computedKey = '';
      }
    }
    this.map.triggerRepaint();
  }

  sampleAtLngLat(lng: number, lat: number): TileMetricSample | null {
    const pos = this.tileManager.getTilePixelAtLngLat(lng, lat, this.currentLevel);
    if (!pos) return null;
    const record = this.tilePairs.get(this.tileKey(pos.id));
    if (!record) return null;

    const tile = record.a ?? record.b;
    if (!tile) return null;

    if (pos.ix >= tile.width || pos.iy >= tile.height) return null;
    const pixelIdx = pos.iy * tile.width + pos.ix;

    const metricA = this.evalMetricAtPixel(record.a, pixelIdx);
    const metricB = this.evalMetricAtPixel(record.b, pixelIdx);
    const nodata = this.metadata.nodata;
    const nodataA = metricA <= nodata + 0.5;
    const nodataB = metricB <= nodata + 0.5;
    const diff = (!nodataA && !nodataB) ? metricB - metricA : nodata;

    return {
      metricA,
      metricB,
      diff,
      nodataA,
      nodataB,
    };
  }

  private handleRender = (): void => {
    if (this.disposed || !this.ready || !this.gpu || !this.computePipeline || !this.renderPipeline) {
      return;
    }

    this.syncCanvasSize();
    this.currentLevel = this.tileManager.chooseZoomLevel(this.map);
    const drawTiles = this.tileManager.getVisibleTiles(this.map, this.currentLevel, 0);
    const loadTiles = this.tileManager.getVisibleTiles(
      this.map,
      this.currentLevel,
      TILE_PREFETCH_PADDING,
    );

    this.frameTick++;
    const active = new Set<string>();
    for (const tile of loadTiles) {
      const rec = this.queueTilePair(tile);
      active.add(this.tileKey(rec.id));
    }

    const drawRecords: TilePairRecord[] = [];
    const dirtyRecords: TilePairRecord[] = [];
    const frameKey = this.computeKey();
    for (const tile of drawTiles) {
      const rec = this.tilePairs.get(this.tileKey(tile));
      if (!rec || !rec.a || !rec.b) continue;
      if (!rec.gpu) {
        this.ensureTileGpuResources(rec);
      }
      if (!rec.gpu) continue;

      drawRecords.push(rec);
      if (rec.computedKey !== frameKey) {
        dirtyRecords.push(rec);
      }
    }

    this.computeDirtyTileMetrics(dirtyRecords, frameKey);
    this.renderTileRecords(drawRecords);
    this.pruneTilePairs(active);
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
        lastSeenTick: this.frameTick,
        gpu: null,
        computedKey: '',
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
      const current = this.tilePairs.get(this.tileKey(record.id));
      if (!current) return;
      current.a = a;
      current.b = b;
      current.loading = false;
      current.computedKey = '';
      current.gpu = null;
      this.map.triggerRepaint();
    } catch (error) {
      console.error('Failed to load temporal tile pair', record.id, error);
      const current = this.tilePairs.get(this.tileKey(record.id));
      if (current) current.loading = false;
    }
  }

  private ensureTileGpuResources(record: TilePairRecord): void {
    if (!this.gpu || !this.computePipeline || !this.renderPipeline || !this.styleBuffer) {
      return;
    }
    if (!record.a || !record.b) return;

    const width = Math.min(record.a.width, record.b.width);
    const height = Math.min(record.a.height, record.b.height);
    const timesteps = Math.min(record.a.timesteps, record.b.timesteps);
    const pixelCount = width * height;
    const valueCount = pixelCount * timesteps;
    const sourceA = this.getTileValuesForUpload(record.a, valueCount);
    const sourceB = this.getTileValuesForUpload(record.b, valueCount);
    const uploadA = this.padUploadData(sourceA);
    const uploadB = this.padUploadData(sourceB);

    const { device, queue } = this.gpu;
    const bufferA = device.createBuffer({
      size: uploadA.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const bufferB = device.createBuffer({
      size: uploadB.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(
      bufferA,
      0,
      uploadA.buffer,
      uploadA.byteOffset,
      uploadA.byteLength,
    );
    queue.writeBuffer(
      bufferB,
      0,
      uploadB.buffer,
      uploadB.byteOffset,
      uploadB.byteLength,
    );

    const paramsBuffer = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const metricTexture = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const metricView = metricTexture.createView();

    const computeBindGroup = device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bufferA } },
        { binding: 1, resource: { buffer: bufferB } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: metricView },
      ],
    });

    const renderBindGroup = device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: metricView },
        { binding: 1, resource: { buffer: this.styleBuffer } },
      ],
    });

    record.gpu = {
      width,
      height,
      timesteps,
      bufferA,
      bufferB,
      paramsBuffer,
      metricTexture,
      metricView,
      computeBindGroup,
      renderBindGroup,
    };
    record.computedKey = '';
  }

  private computeDirtyTileMetrics(
    records: TilePairRecord[],
    key: string,
  ): void {
    if (!this.gpu || !this.computePipeline || records.length === 0) return;

    const modeId = this.modeToId(this.state.mode);
    const metricId = this.metricToId(this.state.metric);
    const paramsRaw = new ArrayBuffer(48);
    const u32 = new Uint32Array(paramsRaw);
    const f32 = new Float32Array(paramsRaw);
    f32[8] = this.state.threshold;
    f32[10] = this.metadata.nodata;

    const { queue, device } = this.gpu;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.computePipeline);

    for (const rec of records) {
      if (!rec.gpu) continue;
      u32[0] = rec.gpu.width;
      u32[1] = rec.gpu.height;
      u32[2] = rec.gpu.timesteps;
      u32[3] = metricId;
      u32[4] = modeId;
      f32[9] = rec.a?.dtHours ?? this.metadata.temporal.dt_hours;

      queue.writeBuffer(rec.gpu.paramsBuffer, 0, paramsRaw);
      pass.setBindGroup(0, rec.gpu.computeBindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(rec.gpu.width / this.workgroupX),
        Math.ceil(rec.gpu.height / this.workgroupY),
      );
      rec.computedKey = key;
    }

    pass.end();
    queue.submit([encoder.finish()]);
  }

  private renderTileRecords(records: TilePairRecord[]): void {
    if (!this.gpu || !this.renderPipeline || !this.styleBuffer) return;
    const { device, queue, context } = this.gpu;

    const styleRaw = new ArrayBuffer(32);
    const styleU32 = new Uint32Array(styleRaw);
    const styleF32 = new Float32Array(styleRaw);
    styleF32[0] = this.state.valueMin;
    styleF32[1] = this.state.valueMax;
    styleF32[2] = this.state.opacity;
    styleU32[3] = this.modeToId(this.state.mode);
    styleF32[4] = this.metadata.nodata;
    queue.writeBuffer(this.styleBuffer, 0, styleRaw);

    const vertices: number[] = [];
    const draws: DrawEntry[] = [];

    for (const rec of records) {
      if (!rec.gpu) continue;
      const corners = this.tileManager.getTileCorners(rec.id);
      if (!corners) continue;

      const nw = this.map.project(corners.nw);
      const ne = this.map.project(corners.ne);
      const se = this.map.project(corners.se);
      const sw = this.map.project(corners.sw);
      const firstVertex = vertices.length / 4;

      this.pushVertex(vertices, nw.x, nw.y, 0, 0);
      this.pushVertex(vertices, ne.x, ne.y, 1, 0);
      this.pushVertex(vertices, se.x, se.y, 1, 1);
      this.pushVertex(vertices, nw.x, nw.y, 0, 0);
      this.pushVertex(vertices, se.x, se.y, 1, 1);
      this.pushVertex(vertices, sw.x, sw.y, 0, 1);

      draws.push({
        bindGroup: rec.gpu.renderBindGroup,
        firstVertex,
      });
    }

    const currentView = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: currentView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    if (vertices.length > 0) {
      const vertexData = new Float32Array(vertices);
      const vertexBuffer = this.ensureVertexBuffer(vertexData.byteLength);
      queue.writeBuffer(vertexBuffer, 0, vertexData);
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setVertexBuffer(0, vertexBuffer);
      for (const draw of draws) {
        renderPass.setBindGroup(0, draw.bindGroup);
        renderPass.draw(6, 1, draw.firstVertex, 0);
      }
      renderPass.end();
      queue.submit([encoder.finish()]);
      return;
    }

    renderPass.end();
    queue.submit([encoder.finish()]);
  }

  private pushVertex(
    target: number[],
    xPx: number,
    yPx: number,
    u: number,
    v: number,
  ): void {
    const clipX = (xPx / this.cssWidth) * 2 - 1;
    const clipY = 1 - (yPx / this.cssHeight) * 2;
    target.push(clipX, clipY, u, v);
  }

  private evalMetricAtPixel(tile: TemporalTile | null, pixelIdx: number): number {
    if (!tile) return this.metadata.nodata;

    const pixelCount = tile.width * tile.height;
    const threshold = this.state.threshold;
    const nodata = this.metadata.nodata;
    const dtHours = tile.dtHours;
    const metric = this.state.metric;

    let hasValid = false;
    let hasArrival = false;
    let arrivalIdx = 0;
    let peakIdx = 0;
    let peakValue = -Infinity;
    let durationSteps = 0;

    for (let t = 0; t < tile.timesteps; t += 1) {
      const value = this.readTileValue(tile, t * pixelCount + pixelIdx);
      if (value <= nodata + 0.5) continue;
      hasValid = true;

      if (value >= threshold) {
        durationSteps += 1;
        if (!hasArrival) {
          hasArrival = true;
          arrivalIdx = t;
        }
      }

      if (value > peakValue) {
        peakValue = value;
        peakIdx = t;
      }
    }

    if (!hasValid) return nodata;
    if (metric === 'arrival') return hasArrival ? arrivalIdx * dtHours : nodata;
    if (metric === 'peak_time') return peakIdx * dtHours;
    if (metric === 'time_to_peak') return hasArrival ? Math.max(0, peakIdx - arrivalIdx) * dtHours : nodata;
    return durationSteps * dtHours;
  }

  private readTileValue(tile: TemporalTile, idx: number): number {
    if (tile.valueType === 'f32') {
      return tile.valuesF32?.[idx] ?? this.metadata.nodata;
    }
    const h = tile.valuesF16?.[idx];
    if (h === undefined) return this.metadata.nodata;
    return this.halfToFloat(h);
  }

  private getTileValuesForUpload(
    tile: TemporalTile,
    count: number,
  ): Float32Array | Uint16Array {
    if (this.computeUsesF16) {
      if (tile.valueType === 'f16' && tile.valuesF16) {
        return tile.valuesF16.subarray(0, count);
      }
      const f32 = tile.valuesF32?.subarray(0, count);
      if (!f32) {
        throw new Error('Missing tile values for f16 upload');
      }
      return this.float32ToHalfArray(f32);
    }

    if (tile.valueType === 'f32' && tile.valuesF32) {
      return tile.valuesF32.subarray(0, count);
    }
    if (tile.valueType === 'f16' && tile.valuesF16) {
      return this.halfArrayToFloat32(tile.valuesF16, count);
    }
    throw new Error('Missing tile values for f32 upload');
  }

  private padUploadData(
    values: Float32Array | Uint16Array,
  ): Float32Array | Uint16Array {
    if (values.byteLength % 4 === 0) return values;
    if (values instanceof Uint16Array) {
      const padded = new Uint16Array(values.length + 1);
      padded.set(values);
      return padded;
    }
    return values;
  }

  private halfArrayToFloat32(values: Uint16Array, count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = this.halfToFloat(values[i]);
    }
    return out;
  }

  private float32ToHalfArray(values: Float32Array): Uint16Array {
    const out = new Uint16Array(values.length);
    for (let i = 0; i < values.length; i += 1) {
      out[i] = this.floatToHalf(values[i]);
    }
    return out;
  }

  private halfToFloat(h: number): number {
    const sign = (h & 0x8000) ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const fraction = h & 0x03ff;

    if (exponent === 0) {
      if (fraction === 0) return sign * 0.0;
      return sign * 2 ** -14 * (fraction / 1024.0);
    }
    if (exponent === 0x1f) {
      return fraction === 0 ? sign * Infinity : NaN;
    }
    return sign * 2 ** (exponent - 15) * (1.0 + fraction / 1024.0);
  }

  private floatToHalf(value: number): number {
    if (Number.isNaN(value)) return 0x7e00;
    if (value === Infinity) return 0x7c00;
    if (value === -Infinity) return 0xfc00;

    const sign = value < 0 ? 0x8000 : 0;
    const abs = Math.abs(value);
    if (abs === 0) return sign;

    let exponent = Math.floor(Math.log2(abs));
    let mantissa = abs / 2 ** exponent;

    exponent += 15;
    if (exponent <= 0) {
      const sub = Math.round(abs / 2 ** -24);
      return sign | (sub & 0x03ff);
    }
    if (exponent >= 0x1f) {
      return sign | 0x7c00;
    }

    mantissa -= 1.0;
    const frac = Math.round(mantissa * 1024.0);
    if (frac === 1024) {
      exponent += 1;
      if (exponent >= 0x1f) {
        return sign | 0x7c00;
      }
      return sign | (exponent << 10);
    }
    return sign | (exponent << 10) | (frac & 0x03ff);
  }

  private ensureVertexBuffer(requiredBytes: number): GPUBuffer {
    if (!this.gpu) {
      throw new Error('GPU context unavailable');
    }
    if (this.vertexBuffer && this.vertexBufferSize >= requiredBytes) {
      return this.vertexBuffer;
    }
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = null;
      this.vertexBufferSize = 0;
    }

    const minSize = 4096;
    const rounded = 2 ** Math.ceil(Math.log2(Math.max(minSize, requiredBytes)));
    this.vertexBuffer = this.gpu.device.createBuffer({
      size: rounded,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.vertexBufferSize = rounded;
    return this.vertexBuffer;
  }

  private chooseWorkgroupSize(): [number, number] {
    if (!this.gpu) {
      return [MIN_WORKGROUP_SIZE, MIN_WORKGROUP_SIZE];
    }

    const maxX = Math.max(1, this.gpu.maxComputeWorkgroupSizeX);
    const maxY = Math.max(1, this.gpu.maxComputeWorkgroupSizeY);
    const maxInv = Math.max(1, this.gpu.maxComputeInvocationsPerWorkgroup);
    const candidates: Array<[number, number]> = [
      [TARGET_WORKGROUP_SIZE, TARGET_WORKGROUP_SIZE],
      [TARGET_WORKGROUP_SIZE, MIN_WORKGROUP_SIZE],
      [MIN_WORKGROUP_SIZE, TARGET_WORKGROUP_SIZE],
      [MIN_WORKGROUP_SIZE, MIN_WORKGROUP_SIZE],
    ];

    for (const [x, y] of candidates) {
      if (x <= maxX && y <= maxY && x * y <= maxInv) {
        return [x, y];
      }
    }

    const fallbackX = Math.max(1, Math.min(MIN_WORKGROUP_SIZE, maxX));
    const fallbackY = Math.max(1, Math.min(MIN_WORKGROUP_SIZE, maxY));
    return [fallbackX, fallbackY];
  }

  private computeKey(): string {
    return [
      this.state.scenarioA,
      this.state.scenarioB,
      this.state.variable,
      this.state.metric,
      this.state.mode,
      this.state.threshold.toFixed(4),
    ].join('|');
  }

  private metricToId(metric: MetricKind): number {
    switch (metric) {
      case 'arrival': return 0;
      case 'peak_time': return 1;
      case 'time_to_peak': return 2;
      case 'duration_above_threshold': return 3;
      default: return 0;
    }
  }

  private modeToId(mode: DisplayMode): number {
    if (mode === 'a') return 0;
    if (mode === 'b') return 1;
    return 2;
  }

  private clearTilePairs(): void {
    for (const rec of this.tilePairs.values()) {
      this.destroyRecordResources(rec);
    }
    this.tilePairs.clear();
  }

  private destroyRecordResources(rec: TilePairRecord): void {
    if (!rec.gpu) return;
    rec.gpu.bufferA.destroy();
    rec.gpu.bufferB.destroy();
    rec.gpu.paramsBuffer.destroy();
    rec.gpu.metricTexture.destroy();
    rec.gpu = null;
  }

  private pruneTilePairs(activeKeys: Set<string>): void {
    if (this.tilePairs.size <= 2600) return;
    const candidates = Array.from(this.tilePairs.entries())
      .filter(([key]) => !activeKeys.has(key))
      .sort((a, b) => a[1].lastSeenTick - b[1].lastSeenTick);
    for (const [key, rec] of candidates) {
      if (this.tilePairs.size <= 2200) break;
      this.destroyRecordResources(rec);
      this.tilePairs.delete(key);
    }
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
      if (this.gpu) {
        this.gpu.context.configure({
          device: this.gpu.device,
          format: this.gpu.format,
          alphaMode: 'premultiplied',
        });
      }
    }

    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
  }
}
