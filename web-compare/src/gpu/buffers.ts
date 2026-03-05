import type { MeshData, CellValues } from '../data/types';

export interface MeshBuffers {
  vertices: GPUBuffer;
  triangles: GPUBuffer;
  cellMap: GPUBuffer;
  numTriangles: number;
  numVertices: number;
}

export interface ValueBuffers {
  valuesA: GPUBuffer;
  valuesB: GPUBuffer;
  diff: GPUBuffer;
  numCells: number;
}

export function createMeshBuffers(device: GPUDevice, mesh: MeshData): MeshBuffers {
  const vertices = device.createBuffer({
    size: mesh.vertices.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(vertices.getMappedRange()).set(mesh.vertices);
  vertices.unmap();

  const triangles = device.createBuffer({
    size: mesh.triangles.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(triangles.getMappedRange()).set(mesh.triangles);
  triangles.unmap();

  const cellMap = device.createBuffer({
    size: mesh.cellMap.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(cellMap.getMappedRange()).set(mesh.cellMap);
  cellMap.unmap();

  return {
    vertices, triangles, cellMap,
    numTriangles: mesh.numTriangles,
    numVertices: mesh.numVertices,
  };
}

export function createValueBuffers(device: GPUDevice, numCells: number): ValueBuffers {
  const size = numCells * 4;
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

  return {
    valuesA: device.createBuffer({ size, usage }),
    valuesB: device.createBuffer({ size, usage }),
    diff: device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    numCells,
  };
}

export function uploadCellValues(device: GPUDevice, buffer: GPUBuffer, data: CellValues) {
  device.queue.writeBuffer(buffer, 0, data.values.buffer, data.values.byteOffset, data.values.byteLength);
}
