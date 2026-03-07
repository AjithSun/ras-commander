struct Params {
  width: u32,
  height: u32,
  timesteps: u32,
  metric: u32,       // 0 arrival, 1 peak_time, 2 time_to_peak, 3 duration
  mode: u32,         // 0 scenario A, 1 scenario B, 2 diff
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  threshold: f32,
  dt_hours: f32,
  nodata: f32,
  _pad3: f32,
}

@group(0) @binding(0) var<storage, read> values_a: array<f32>;
@group(0) @binding(1) var<storage, read> values_b: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var metric_out: texture_storage_2d<r32float, write>;

override WG_X: u32 = 8u;
override WG_Y: u32 = 8u;

fn eval_metric(values: ptr<storage, array<f32>, read>, pixel_idx: u32) -> f32 {
  let pixel_count = params.width * params.height;

  var has_valid = false;
  var has_arrival = false;
  var arrival_idx: u32 = 0u;
  var peak_idx: u32 = 0u;
  var peak_val: f32 = -1e30;
  var duration_steps: u32 = 0u;

  for (var t: u32 = 0u; t < params.timesteps; t = t + 1u) {
    let v = (*values)[t * pixel_count + pixel_idx];
    if (v <= params.nodata + 0.5) {
      continue;
    }

    has_valid = true;

    if (v >= params.threshold) {
      duration_steps = duration_steps + 1u;
      if (!has_arrival) {
        has_arrival = true;
        arrival_idx = t;
      }
    }

    if (v > peak_val) {
      peak_val = v;
      peak_idx = t;
    }
  }

  if (!has_valid) {
    return params.nodata;
  }

  if (params.metric == 0u) {
    if (!has_arrival) {
      return params.nodata;
    }
    return f32(arrival_idx) * params.dt_hours;
  }

  if (params.metric == 1u) {
    return f32(peak_idx) * params.dt_hours;
  }

  if (params.metric == 2u) {
    if (!has_arrival) {
      return params.nodata;
    }
    if (peak_idx < arrival_idx) {
      return 0.0;
    }
    return f32(peak_idx - arrival_idx) * params.dt_hours;
  }

  // duration_above_threshold
  return f32(duration_steps) * params.dt_hours;
}

@compute @workgroup_size(WG_X, WG_Y, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }

  let idx = gid.y * params.width + gid.x;
  let metric_a = eval_metric(&values_a, idx);
  let metric_b = eval_metric(&values_b, idx);

  var out_val = params.nodata;
  if (params.mode == 0u) {
    out_val = metric_a;
  } else if (params.mode == 1u) {
    out_val = metric_b;
  } else {
    if (metric_a > params.nodata + 0.5 && metric_b > params.nodata + 0.5) {
      out_val = metric_b - metric_a;
    }
  }

  textureStore(metric_out, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(out_val, 0.0, 0.0, 1.0));
}
