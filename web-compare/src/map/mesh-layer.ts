import type maplibregl from 'maplibre-gl';
import type { MeshBuffers, ValueBuffers } from '../gpu/buffers';
import type { DisplayMode } from '../data/types';
import { MeshRenderer } from '../gpu/render';
import { DifferenceCompute } from '../gpu/compute';

export interface MeshLayerState {
  mode: DisplayMode;
  valueMin: number;
  valueMax: number;
  opacity: number;
  nodata: number;
  dirty: boolean;
}

/**
 * MapLibre custom layer that renders WebGPU mesh to an overlay canvas.
 * No readback needed — WebGPU renders directly to a transparent canvas
 * positioned over the MapLibre WebGL canvas.
 */
export function createMeshLayer(
  device: GPUDevice,
  meshBuffers: MeshBuffers,
  valueBuffers: ValueBuffers,
  state: MeshLayerState,
): maplibregl.CustomLayerInterface {
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  const renderer = new MeshRenderer(device, canvasFormat);
  const compute = new DifferenceCompute(device);

  let gpuCanvas: HTMLCanvasElement | null = null;
  let gpuContext: GPUCanvasContext | null = null;

  return {
    id: 'mesh-layer',
    type: 'custom' as const,
    renderingMode: '2d' as const,

    onAdd(map, _gl) {
      // Create an overlay canvas for WebGPU rendering
      const mapCanvas = map.getCanvas();
      gpuCanvas = document.createElement('canvas');
      gpuCanvas.style.position = 'absolute';
      gpuCanvas.style.top = '0';
      gpuCanvas.style.left = '0';
      gpuCanvas.style.pointerEvents = 'none';
      gpuCanvas.width = mapCanvas.width;
      gpuCanvas.height = mapCanvas.height;
      gpuCanvas.style.width = mapCanvas.style.width;
      gpuCanvas.style.height = mapCanvas.style.height;
      mapCanvas.parentElement!.appendChild(gpuCanvas);

      gpuContext = gpuCanvas.getContext('webgpu')!;
      gpuContext.configure({
        device,
        format: canvasFormat,
        alphaMode: 'premultiplied',
      });
    },

    render(_gl, matrix) {
      if (!gpuCanvas || !gpuContext) return;

      // Sync overlay canvas size with map canvas
      const mapCanvas = (_gl as WebGL2RenderingContext).canvas as HTMLCanvasElement;
      const w = mapCanvas.width;
      const h = mapCanvas.height;

      if (gpuCanvas.width !== w || gpuCanvas.height !== h) {
        gpuCanvas.width = w;
        gpuCanvas.height = h;
        gpuCanvas.style.width = mapCanvas.style.width;
        gpuCanvas.style.height = mapCanvas.style.height;
        gpuContext.configure({
          device,
          format: canvasFormat,
          alphaMode: 'premultiplied',
        });
      }

      const projMatrix = matrix as unknown as Float64Array;

      // Run compute shader for difference mode
      if (state.dirty && state.mode === 'diff') {
        compute.dispatch(valueBuffers, state.nodata);
      }
      state.dirty = false;

      // Render mesh directly to the overlay canvas
      const textureView = gpuContext.getCurrentTexture().createView();
      renderer.render(
        textureView, meshBuffers, valueBuffers, projMatrix,
        state.mode, state.valueMin, state.valueMax,
        state.opacity, state.nodata,
      );
    },

    onRemove() {
      gpuCanvas?.remove();
    },
  };
}
