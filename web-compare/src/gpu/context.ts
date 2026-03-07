export interface GpuContext {
  device: GPUDevice;
  queue: GPUQueue;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  supportsShaderF16: boolean;
  maxComputeInvocationsPerWorkgroup: number;
  maxComputeWorkgroupSizeX: number;
  maxComputeWorkgroupSizeY: number;
}

export async function initGpuContext(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is required but not available in this browser.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('No suitable GPU adapter found.');
  }

  const supportsShaderF16 = adapter.features.has('shader-f16');
  const requiredFeatures: GPUFeatureName[] = [];
  if (supportsShaderF16) {
    requiredFeatures.push('shader-f16');
  }
  const device = await adapter.requestDevice({ requiredFeatures });
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Failed to acquire WebGPU context.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  return {
    device,
    queue: device.queue,
    context,
    format,
    supportsShaderF16,
    maxComputeInvocationsPerWorkgroup:
      device.limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
    maxComputeWorkgroupSizeY: device.limits.maxComputeWorkgroupSizeY,
  };
}
