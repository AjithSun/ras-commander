struct VertexIn {
  @location(0) clip_pos: vec2<f32>,
  @location(1) uv: vec2<f32>,
}

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct Style {
  value_min: f32,
  value_max: f32,
  opacity: f32,
  mode: u32,    // 0 A, 1 B, 2 diff
  nodata: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var metric_tex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> style: Style;

@vertex
fn vs_main(v: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(v.clip_pos, 0.0, 1.0);
  out.uv = v.uv;
  return out;
}

fn clamp01(x: f32) -> f32 {
  return max(0.0, min(1.0, x));
}

fn mix3(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
  return a + (b - a) * t;
}

fn sample_seq(t: f32) -> vec3<f32> {
  let c0 = vec3<f32>(237.0, 245.0, 255.0) / 255.0;
  let c1 = vec3<f32>(107.0, 173.0, 215.0) / 255.0;
  let c2 = vec3<f32>(8.0, 48.0, 107.0) / 255.0;
  if (t <= 0.5) {
    return mix3(c0, c1, t * 2.0);
  }
  return mix3(c1, c2, (t - 0.5) * 2.0);
}

fn sample_div(t: f32) -> vec3<f32> {
  let c0 = vec3<f32>(30.0, 99.0, 176.0) / 255.0;
  let c1 = vec3<f32>(255.0, 255.0, 255.0) / 255.0;
  let c2 = vec3<f32>(214.0, 39.0, 40.0) / 255.0;
  if (t <= 0.5) {
    return mix3(c0, c1, t * 2.0);
  }
  return mix3(c1, c2, (t - 0.5) * 2.0);
}

fn fetch_value(ix: i32, iy: i32) -> f32 {
  return textureLoad(metric_tex, vec2<i32>(ix, iy), 0).r;
}

fn sample_metric_bilinear(uv: vec2<f32>) -> f32 {
  let dims_u = textureDimensions(metric_tex, 0);
  let w = max(1, i32(dims_u.x));
  let h = max(1, i32(dims_u.y));

  let x = clamp(uv.x * f32(max(1u, dims_u.x - 1u)), 0.0, f32(w - 1));
  let y = clamp(uv.y * f32(max(1u, dims_u.y - 1u)), 0.0, f32(h - 1));

  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let x1 = min(x0 + 1, w - 1);
  let y1 = min(y0 + 1, h - 1);

  let tx = x - f32(x0);
  let ty = y - f32(y0);

  let v00 = fetch_value(x0, y0);
  let v10 = fetch_value(x1, y0);
  let v01 = fetch_value(x0, y1);
  let v11 = fetch_value(x1, y1);

  let w00 = (1.0 - tx) * (1.0 - ty);
  let w10 = tx * (1.0 - ty);
  let w01 = (1.0 - tx) * ty;
  let w11 = tx * ty;

  var sum = 0.0;
  var wsum = 0.0;

  if (v00 > style.nodata + 0.5) {
    sum = sum + v00 * w00;
    wsum = wsum + w00;
  }
  if (v10 > style.nodata + 0.5) {
    sum = sum + v10 * w10;
    wsum = wsum + w10;
  }
  if (v01 > style.nodata + 0.5) {
    sum = sum + v01 * w01;
    wsum = wsum + w01;
  }
  if (v11 > style.nodata + 0.5) {
    sum = sum + v11 * w11;
    wsum = wsum + w11;
  }

  if (wsum <= 1e-9) {
    return style.nodata;
  }
  return sum / wsum;
}

@fragment
fn fs_main(inf: VertexOut) -> @location(0) vec4<f32> {
  let value = sample_metric_bilinear(inf.uv);
  let range = style.value_max - style.value_min;
  if (value <= style.nodata + 0.5 || range <= 1e-9) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  var color = vec3<f32>(0.0, 0.0, 0.0);
  if (style.mode == 2u) {
    let max_abs = max(abs(style.value_min), abs(style.value_max));
    let t = clamp01((value + max_abs) / (2.0 * max_abs));
    color = sample_div(t);
  } else {
    let t = clamp01((value - style.value_min) / range);
    color = sample_seq(t);
  }

  let alpha = clamp01(style.opacity);
  return vec4<f32>(color * alpha, alpha);
}
