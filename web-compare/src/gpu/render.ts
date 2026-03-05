import type { MeshBuffers, ValueBuffers } from './buffers';
import type { DisplayMode } from '../data/types';
import meshWGSL from './shaders/mesh.wgsl?raw';

/**
 * Renders the mesh directly to a provided GPUTextureView (e.g. canvas surface).
 * No offscreen texture or readback needed.
 */
export class MeshRenderer {
  private device: GPUDevice;
  private pipeline!: GPURenderPipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private uniformBuffer!: GPUBuffer;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.initPipeline(format);
  }

  private initPipeline(format: GPUTextureFormat) {
    const device = this.device;

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: meshWGSL });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            // Premultiplied alpha blending
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Uniform buffer: mat4(64) + 8 floats(32) = 96 bytes
    this.uniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  render(
    target: GPUTextureView,
    meshBuffers: MeshBuffers,
    valueBuffers: ValueBuffers,
    matrix: Float64Array,
    mode: DisplayMode,
    valueMin: number,
    valueMax: number,
    opacity: number,
    nodata: number,
  ): void {
    const { device } = this;

    // Choose which value buffer to use for coloring
    let colorBuffer: GPUBuffer;
    let colorMode: number;
    if (mode === 'diff') {
      colorBuffer = valueBuffers.diff;
      colorMode = 1;
    } else if (mode === 'b') {
      colorBuffer = valueBuffers.valuesB;
      colorMode = 0;
    } else {
      colorBuffer = valueBuffers.valuesA;
      colorMode = 0;
    }

    // Write uniforms
    const uniforms = new ArrayBuffer(96);
    const fv = new Float32Array(uniforms);
    const uv = new Uint32Array(uniforms);

    // Copy matrix (convert float64 to float32)
    for (let i = 0; i < 16; i++) {
      fv[i] = matrix[i];
    }
    fv[16] = valueMin;
    fv[17] = valueMax;
    fv[18] = opacity;
    uv[19] = colorMode;
    fv[20] = nodata;

    device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: meshBuffers.vertices } },
        { binding: 2, resource: { buffer: colorBuffer } },
        { binding: 3, resource: { buffer: meshBuffers.cellMap } },
        { binding: 4, resource: { buffer: meshBuffers.triangles } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, meshBuffers.numTriangles, 0, 0);
    pass.end();

    device.queue.submit([encoder.finish()]);
  }
}
