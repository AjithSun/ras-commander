struct Params {
  num_cells: u32,
  nodata: f32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> values_a: array<f32>;
@group(0) @binding(2) var<storage, read> values_b: array<f32>;
@group(0) @binding(3) var<storage, read_write> diff: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.num_cells) { return; }

  let a = values_a[i];
  let b = values_b[i];
  let nd = params.nodata;

  // If either value is nodata, output nodata
  if (a <= nd + 0.5 || b <= nd + 0.5) {
    diff[i] = nd;
    return;
  }

  diff[i] = b - a;  // positive = water rose in B relative to A
}
