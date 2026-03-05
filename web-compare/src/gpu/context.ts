export interface GpuContext {
  device: GPUDevice;
  available: true;
}

export interface GpuUnavailable {
  available: false;
  reason: string;
}

export type GpuResult = GpuContext | GpuUnavailable;

export async function initWebGPU(): Promise<GpuResult> {
  if (!navigator.gpu) {
    return { available: false, reason: 'WebGPU not supported in this browser. Use Chrome 113+.' };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    return { available: false, reason: 'No WebGPU adapter found.' };
  }

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: 64 * 1024 * 1024, // 64MB
      maxBufferSize: 256 * 1024 * 1024,              // 256MB
    },
  });

  device.lost.then((info) => {
    console.error('WebGPU device lost:', info.message);
  });

  return { device, available: true };
}
