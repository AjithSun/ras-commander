import type { ValueBuffers } from './buffers';
import differenceWGSL from './shaders/difference.wgsl?raw';

export class DifferenceCompute {
  private pipeline: GPUComputePipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private paramsBuffer: GPUBuffer;
  private device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: differenceWGSL });

    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    // Params buffer: num_cells(u32) + nodata(f32) + 2 padding u32 = 16 bytes
    this.paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  dispatch(valueBuffers: ValueBuffers, nodata: number) {
    const { numCells } = valueBuffers;

    // Write params
    const params = new ArrayBuffer(16);
    const view = new DataView(params);
    view.setUint32(0, numCells, true);
    view.setFloat32(4, nodata, true);
    view.setUint32(8, 0, true); // padding
    view.setUint32(12, 0, true); // padding
    this.device.queue.writeBuffer(this.paramsBuffer, 0, params);

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: valueBuffers.valuesA } },
        { binding: 2, resource: { buffer: valueBuffers.valuesB } },
        { binding: 3, resource: { buffer: valueBuffers.diff } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(numCells / 256));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
