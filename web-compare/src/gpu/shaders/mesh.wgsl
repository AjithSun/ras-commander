struct Uniforms {
  matrix: mat4x4<f32>,
  value_min: f32,
  value_max: f32,
  opacity: f32,
  color_mode: u32,    // 0=sequential (single scenario), 1=diverging (difference)
  nodata: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> vertices: array<f32>;     // [lng,lat,...] interleaved
@group(0) @binding(2) var<storage, read> cell_values: array<f32>;
@group(0) @binding(3) var<storage, read> cell_map: array<u32>;     // triangle_id -> cell_id
@group(0) @binding(4) var<storage, read> triangles: array<u32>;    // [v0,v1,v2,...] 3 per tri

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) value: f32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) local_vid: u32,       // 0, 1, or 2 within each triangle instance
  @builtin(instance_index) tri_id: u32,         // which triangle
) -> VertexOutput {
  // Look up the actual vertex index from the triangle array
  let vertex_idx = triangles[tri_id * 3u + local_vid];

  let lng = vertices[vertex_idx * 2u];
  let lat = vertices[vertex_idx * 2u + 1u];

  // Convert lng/lat to Web Mercator [0,1] range
  let merc_x = (lng + 180.0) / 360.0;
  let sin_lat = sin(lat * 3.14159265359 / 180.0);
  let merc_y = 0.5 - log((1.0 + sin_lat) / (1.0 - sin_lat)) / (4.0 * 3.14159265359);

  let pos = uniforms.matrix * vec4<f32>(merc_x, merc_y, 0.0, 1.0);

  // Look up cell value for this triangle
  let cell_id = cell_map[tri_id];
  let val = cell_values[cell_id];

  var out: VertexOutput;
  out.position = pos;
  out.value = val;
  return out;
}

// Diverging colormap: blue - white - red
fn diverging_color(t: f32) -> vec3<f32> {
  if (t < 0.0) {
    let s = -t;
    return mix(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(0.12, 0.39, 0.69), s);
  } else {
    return mix(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(0.84, 0.15, 0.16), t);
  }
}

// Sequential colormap: light blue to dark blue
fn sequential_color(t: f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.93, 0.96, 1.0);
  let c1 = vec3<f32>(0.42, 0.68, 0.84);
  let c2 = vec3<f32>(0.03, 0.19, 0.42);

  if (t < 0.5) {
    return mix(c0, c1, t * 2.0);
  } else {
    return mix(c1, c2, (t - 0.5) * 2.0);
  }
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let val = in.value;

  if (val <= uniforms.nodata + 0.5) {
    discard;
  }

  let vmin = uniforms.value_min;
  let vmax = uniforms.value_max;
  var color: vec3<f32>;

  if (uniforms.color_mode == 1u) {
    let range = max(abs(vmin), abs(vmax));
    let t = clamp(val / max(range, 0.001), -1.0, 1.0);
    color = diverging_color(t);
    let alpha = uniforms.opacity * smoothstep(0.0, 0.05, abs(t));
    return vec4<f32>(color * alpha, alpha);  // premultiplied alpha
  } else {
    if (val <= 0.01) { discard; }
    let t = clamp((val - vmin) / max(vmax - vmin, 0.001), 0.0, 1.0);
    color = sequential_color(t);
    let alpha = uniforms.opacity;
    return vec4<f32>(color * alpha, alpha);  // premultiplied alpha
  }
}
