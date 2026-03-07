"""
Build multi-zoom temporal tile bundles for WebGPU flood timing metrics.

Input:
- export manifest from working/export_kdd2d_required_inputs.py

Output:
1) data/metadata.json
2) data/tile_geometries.json
3) data/tiles/{scenario}/{variable}/{z}/{x}/{y}.tbin

Temporal tile binary format (.tbin), little-endian:
- width: uint16
- height: uint16
- timesteps: uint16
- flags: uint16 (bit 0 = float16 payload)
- nodata: float32
- dt_hours: float32
- values: float32|float16[timesteps * height * width] (time-major, row-major)
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.spatial import cKDTree

NODATA_DEFAULT = -9999.0
VARIABLE_NAME = "depth_derived"
FLAG_FLOAT16 = 1


@dataclass(frozen=True)
class ScenarioData:
  name: str
  plan_number: str
  plan_title: str
  depth_npz: Path
  centers_parquet: Path
  time_axis_csv: Path


def sanitize_name(name: str) -> str:
  chars = []
  for c in name.lower():
    if c.isalnum():
      chars.append(c)
    elif chars and chars[-1] != "_":
      chars.append("_")
  return "".join(chars).strip("_")


def parse_manifest(manifest_path: Path) -> Tuple[List[ScenarioData], Dict]:
  manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
  scenarios: List[ScenarioData] = []
  for item in manifest["scenarios"]:
    mesh = item["mesh_exports"][0]
    files = mesh["files"]
    scenarios.append(
      ScenarioData(
        name=sanitize_name(item["plan_title"]),
        plan_number=item["plan_number"],
        plan_title=item["plan_title"],
        depth_npz=Path(files["depth_timeseries_derived_npz"]),
        centers_parquet=Path(files["cell_centers_parquet"]),
        time_axis_csv=Path(item["time_axis_file"]),
      )
    )
  return scenarios, manifest


def infer_time_axis(time_axis_csv: Path) -> Tuple[int, float, str]:
  df = pd.read_csv(time_axis_csv)
  if len(df) < 2:
    raise ValueError(f"Need at least 2 timesteps in {time_axis_csv}")

  if "timestamp_iso" in df.columns and df["timestamp_iso"].notna().all():
    ts = pd.to_datetime(df["timestamp_iso"], utc=False)
    dt_hours = float((ts.iloc[1] - ts.iloc[0]).total_seconds() / 3600.0)
    sim_start_iso = ts.iloc[0].isoformat()
  else:
    time_raw = df["time_raw"].to_numpy(dtype=np.float64)
    dt_hours = float((time_raw[1] - time_raw[0]) * 24.0)
    sim_start_iso = ""

  return len(df), dt_hours, sim_start_iso


def build_grid(
  centers_xy: np.ndarray,
  grid_width: int,
) -> Tuple[int, np.ndarray, np.ndarray, Tuple[float, float, float, float]]:
  xmin = float(np.min(centers_xy[:, 0]))
  xmax = float(np.max(centers_xy[:, 0]))
  ymin = float(np.min(centers_xy[:, 1]))
  ymax = float(np.max(centers_xy[:, 1]))
  dx = xmax - xmin
  dy = ymax - ymin
  if dx <= 0 or dy <= 0:
    raise ValueError("Invalid bounds from cell centers")

  aspect = dx / dy
  grid_height = max(1, int(round(grid_width / aspect)))
  x = np.linspace(xmin, xmax, grid_width, dtype=np.float64)
  y = np.linspace(ymax, ymin, grid_height, dtype=np.float64)
  return grid_height, x, y, (xmin, ymin, xmax, ymax)


def estimate_native_grid_width(centers_xy: np.ndarray) -> int:
  xmin = float(np.min(centers_xy[:, 0]))
  xmax = float(np.max(centers_xy[:, 0]))
  ymin = float(np.min(centers_xy[:, 1]))
  ymax = float(np.max(centers_xy[:, 1]))
  dx = xmax - xmin
  dy = ymax - ymin
  if dx <= 0 or dy <= 0:
    raise ValueError("Invalid bounds from cell centers")
  aspect = dx / dy
  cell_count = max(1, centers_xy.shape[0])
  return max(64, int(round(math.sqrt(cell_count * aspect))))


def pixel_coordinates(x_coords: np.ndarray, y_coords: np.ndarray) -> np.ndarray:
  xx, yy = np.meshgrid(x_coords, y_coords)
  return np.column_stack([xx.ravel(), yy.ravel()])


def map_pixels_to_cells(
  centers_xy: np.ndarray,
  pixels_xy: np.ndarray,
  k: int,
  idw_power: float,
) -> Tuple[np.ndarray, np.ndarray]:
  tree = cKDTree(centers_xy)
  dists, idx = tree.query(pixels_xy, k=k)

  if k == 1:
    idx2 = idx.reshape(-1, 1).astype(np.int32, copy=False)
    w2 = np.ones((idx2.shape[0], 1), dtype=np.float32)
    return idx2, w2

  d = np.asarray(dists, dtype=np.float64)
  i = np.asarray(idx, dtype=np.int32)
  eps = 1e-9

  exact = d <= eps
  weights = np.zeros_like(d, dtype=np.float64)

  has_exact = np.any(exact, axis=1)
  if np.any(has_exact):
    weights[has_exact] = exact[has_exact].astype(np.float64)
    sums = np.sum(weights[has_exact], axis=1, keepdims=True)
    weights[has_exact] /= sums

  non_exact = ~has_exact
  if np.any(non_exact):
    inv = 1.0 / np.power(np.maximum(d[non_exact], eps), idw_power)
    inv_sum = np.sum(inv, axis=1, keepdims=True)
    weights[non_exact] = inv / inv_sum

  return i, weights.astype(np.float32)


def project_bounds_wgs84(
  bounds_xy: Tuple[float, float, float, float],
  src_epsg: int,
) -> Tuple[float, float, float, float]:
  transformer = Transformer.from_crs(src_epsg, 4326, always_xy=True)
  xmin, ymin, xmax, ymax = bounds_xy
  xs = [xmin, xmax, xmin, xmax]
  ys = [ymin, ymin, ymax, ymax]
  lngs, lats = transformer.transform(xs, ys)
  return min(lngs), min(lats), max(lngs), max(lats)


def max_zoom_for_grid(width: int, height: int, tile_size: int) -> int:
  ratio = max(width, height) / tile_size
  if ratio <= 1:
    return 0
  return int(math.ceil(math.log2(ratio)))


def level_shape(
  full_width: int,
  full_height: int,
  tile_size: int,
  max_zoom: int,
  z: int,
) -> Tuple[int, int, int, int, int]:
  scale = 2 ** (max_zoom - z)
  w = int(math.ceil(full_width / scale))
  h = int(math.ceil(full_height / scale))
  tx = int(math.ceil(w / tile_size))
  ty = int(math.ceil(h / tile_size))
  return w, h, tx, ty, scale


def level_coords(coords: np.ndarray, scale: int, level_len: int) -> np.ndarray:
  idx = np.minimum(np.arange(level_len, dtype=np.int64) * scale, len(coords) - 1)
  return coords[idx]


def project_tile_corners(
  x_level: np.ndarray,
  y_level: np.ndarray,
  tx: int,
  ty: int,
  tile_size: int,
  transformer: Transformer,
) -> List[float]:
  h = len(y_level)
  w = len(x_level)
  x0 = tx * tile_size
  y0 = ty * tile_size
  x1 = min(x0 + tile_size, w)
  y1 = min(y0 + tile_size, h)

  px_py = [
    (x0, y0),
    (max(x1 - 1, x0), y0),
    (max(x1 - 1, x0), max(y1 - 1, y0)),
    (x0, max(y1 - 1, y0)),
  ]

  out: List[float] = []
  for px, py in px_py:
    sx = float(x_level[px])
    sy = float(y_level[py])
    lng, lat = transformer.transform(sx, sy)
    out.extend([round(float(lng), 10), round(float(lat), 10)])
  return out


def write_temporal_tile(
  path: Path,
  values_thw: np.ndarray,
  nodata: float,
  dt_hours: float,
  value_dtype: str,
) -> None:
  if values_thw.ndim != 3:
    raise ValueError(f"Expected 3D values array (T,H,W), got {values_thw.shape}")
  t, h, w = values_thw.shape
  if value_dtype not in ("float32", "float16"):
    raise ValueError(f"Unsupported value dtype: {value_dtype}")

  flags = FLAG_FLOAT16 if value_dtype == "float16" else 0
  dtype = np.float16 if value_dtype == "float16" else np.float32
  payload = values_thw.astype(dtype, copy=False).ravel(order="C")

  # queue.writeBuffer requires 4-byte aligned payload sizes; pad 16-bit tiles.
  if value_dtype == "float16" and payload.size % 2 == 1:
    payload = np.concatenate(
      [payload, np.array([np.float16(nodata)], dtype=np.float16)]
    )

  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("wb") as f:
    f.write(struct.pack("<HHHHff", w, h, t, flags, nodata, dt_hours))
    f.write(payload.tobytes(order="C"))


def write_metadata(
  output_dir: Path,
  scenarios: List[ScenarioData],
  tile_size: int,
  min_zoom: int,
  max_zoom: int,
  full_width: int,
  full_height: int,
  bounds_wgs84: Tuple[float, float, float, float],
  timesteps: int,
  dt_hours: float,
  sim_start_iso: str,
  nodata: float,
  interp_k: int,
  idw_power: float,
  value_dtype: str,
  grid_width: int,
  grid_mode: str,
) -> None:
  sim_hours = (timesteps - 1) * dt_hours
  metadata = {
    "format": "temporal_tile_v1",
    "nodata": nodata,
    "temporal": {
      "timesteps": timesteps,
      "dt_hours": dt_hours,
      "simulation_start_iso": sim_start_iso,
      "simulation_duration_hours": sim_hours,
      "threshold_default": 0.5,
      "value_dtype": value_dtype,
    },
    "tile_grid": {
      "tile_size": tile_size,
      "min_zoom": min_zoom,
      "max_zoom": max_zoom,
      "full_width": full_width,
      "full_height": full_height,
      "grid_width_arg": grid_width,
      "grid_mode": grid_mode,
      "bounds": list(bounds_wgs84),
      "tile_geometries_file": "tile_geometries.json",
    },
    "variables": [VARIABLE_NAME],
    "metrics": [
      "arrival",
      "peak_time",
      "time_to_peak",
      "duration_above_threshold",
    ],
    "metric_ranges_hours": {
      "arrival": [0.0, sim_hours],
      "peak_time": [0.0, sim_hours],
      "time_to_peak": [0.0, sim_hours],
      "duration_above_threshold": [0.0, sim_hours],
    },
    "rasterization": {
      "method": "idw_from_cell_centers" if interp_k > 1 else "nearest_center",
      "neighbors": interp_k,
      "idw_power": idw_power if interp_k > 1 else None,
    },
    "scenarios": {
      s.name: {
        "plan_number": s.plan_number,
        "plan_title": s.plan_title,
        "variables": {
          VARIABLE_NAME: {
            "path_template": f"tiles/{s.name}/{VARIABLE_NAME}" + "/{z}/{x}/{y}.tbin",
          },
        },
      }
      for s in scenarios
    },
  }
  (output_dir / "metadata.json").write_text(
    json.dumps(metadata, indent=2),
    encoding="utf-8",
  )


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
    "--export-manifest",
    type=Path,
    default=Path(
      r"C:\Users\ajith\Downloads\KDD_2D\KDD_2D\exports\required_inputs_v2\export_manifest.json"
    ),
    help="Path to required_inputs_v2 export manifest JSON",
  )
  parser.add_argument(
    "--output-dir",
    type=Path,
    default=Path(__file__).resolve().parent.parent / "data",
    help="Output web-compare data directory",
  )
  parser.add_argument("--tile-size", type=int, default=256)
  parser.add_argument(
    "--grid-width",
    type=int,
    default=1024,
    help="Full-resolution raster width used for tiling",
  )
  parser.add_argument(
    "--native-grid",
    action="store_true",
    help=(
      "Approximate native mesh resolution from cell count + aspect. "
      "Use --native-scale to oversample."
    ),
  )
  parser.add_argument(
    "--native-scale",
    type=float,
    default=1.0,
    help="Multiplier applied when --native-grid is enabled (e.g. 2.0 = 2x native)",
  )
  parser.add_argument(
    "--max-zoom",
    type=int,
    default=None,
    help="Optional explicit max zoom. Default derives from grid size.",
  )
  parser.add_argument("--source-epsg", type=int, default=2278)
  parser.add_argument("--nodata", type=float, default=NODATA_DEFAULT)
  parser.add_argument(
    "--interp-k",
    type=int,
    default=3,
    help="Nearest neighbors for interpolation (1 = nearest)",
  )
  parser.add_argument(
    "--idw-power",
    type=float,
    default=2.0,
    help="Inverse-distance weighting power for interp-k > 1",
  )
  parser.add_argument(
    "--value-dtype",
    type=str,
    choices=("float32", "float16"),
    default="float16",
    help="Temporal payload dtype written into .tbin files",
  )
  parser.add_argument(
    "--clean-output",
    action=argparse.BooleanOptionalAction,
    default=True,
    help="Remove existing output tiles before writing new bundles",
  )
  args = parser.parse_args()

  scenarios, _ = parse_manifest(args.export_manifest.resolve())
  if not scenarios:
    raise ValueError("No scenarios found in export manifest")

  output_dir = args.output_dir.resolve()
  output_dir.mkdir(parents=True, exist_ok=True)
  tiles_dir = output_dir / "tiles"
  if args.clean_output and tiles_dir.exists():
    shutil.rmtree(tiles_dir)

  first = scenarios[0]
  centers_df = pd.read_parquet(first.centers_parquet)
  centers_xy = centers_df[["x", "y"]].to_numpy(dtype=np.float64)
  timesteps, dt_hours, sim_start_iso = infer_time_axis(first.time_axis_csv)

  if args.native_grid:
    native_width = estimate_native_grid_width(centers_xy)
    grid_width = max(64, int(round(native_width * max(0.1, args.native_scale))))
    grid_mode = "native"
  else:
    grid_width = int(args.grid_width)
    grid_mode = "fixed"

  grid_height, x_coords, y_coords, bounds_xy = build_grid(centers_xy, grid_width)
  pixels_xy = pixel_coordinates(x_coords, y_coords)
  interp_k = max(1, int(args.interp_k))
  interp_idx, interp_w = map_pixels_to_cells(
    centers_xy=centers_xy,
    pixels_xy=pixels_xy,
    k=interp_k,
    idw_power=float(args.idw_power),
  )

  full_w = len(x_coords)
  full_h = grid_height
  min_zoom = 0
  max_zoom = (
    int(args.max_zoom)
    if args.max_zoom is not None
    else max_zoom_for_grid(full_w, full_h, args.tile_size)
  )
  bounds_wgs84 = project_bounds_wgs84(bounds_xy, args.source_epsg)

  transformer = Transformer.from_crs(args.source_epsg, 4326, always_xy=True)
  tile_geometries: Dict[str, List[float]] = {}
  for z in range(min_zoom, max_zoom + 1):
    level_w, level_h, tiles_x, tiles_y, scale = level_shape(
      full_w,
      full_h,
      args.tile_size,
      max_zoom,
      z,
    )
    x_level = level_coords(x_coords, scale, level_w)
    y_level = level_coords(y_coords, scale, level_h)
    for ty in range(tiles_y):
      for tx in range(tiles_x):
        key = f"{z}/{tx}/{ty}"
        tile_geometries[key] = project_tile_corners(
          x_level,
          y_level,
          tx,
          ty,
          args.tile_size,
          transformer,
        )

  pixel_ids_full = np.arange(full_h * full_w, dtype=np.int32).reshape(full_h, full_w)
  print(
    f"Grid {full_w}x{full_h}, zoom {min_zoom}..{max_zoom}, "
    f"interp_k={interp_k}, dtype={args.value_dtype}, grid_mode={grid_mode}"
  )

  for scenario in scenarios:
    depth_npz = np.load(scenario.depth_npz)
    depth = depth_npz["values"].astype(np.float32, copy=False)
    if depth.shape[0] != timesteps:
      raise ValueError(
        f"Timestep mismatch for {scenario.name}: {depth.shape[0]} vs {timesteps}"
      )

    print(f"Writing scenario {scenario.name} ...")
    for z in range(min_zoom, max_zoom + 1):
      level_w, level_h, tiles_x, tiles_y, scale = level_shape(
        full_w,
        full_h,
        args.tile_size,
        max_zoom,
        z,
      )
      level_ids = pixel_ids_full[::scale, ::scale][:level_h, :level_w]

      for ty in range(tiles_y):
        y0 = ty * args.tile_size
        y1 = min(y0 + args.tile_size, level_h)
        for tx in range(tiles_x):
          x0 = tx * args.tile_size
          x1 = min(x0 + args.tile_size, level_w)

          ids_flat = level_ids[y0:y1, x0:x1].ravel()
          idx = interp_idx[ids_flat]
          w = interp_w[ids_flat]

          if interp_k == 1:
            tile_vals = depth[:, idx[:, 0]]
          else:
            # Weighted blend across nearest cell centers.
            tile_vals = np.einsum("tpk,pk->tp", depth[:, idx], w, optimize=True)

          tile_cube = tile_vals.reshape(timesteps, y1 - y0, x1 - x0)
          out_path = (
            output_dir
            / "tiles"
            / scenario.name
            / VARIABLE_NAME
            / str(z)
            / str(tx)
            / f"{ty}.tbin"
          )
          write_temporal_tile(
            out_path,
            tile_cube,
            args.nodata,
            dt_hours,
            args.value_dtype,
          )

  write_metadata(
    output_dir=output_dir,
    scenarios=scenarios,
    tile_size=args.tile_size,
    min_zoom=min_zoom,
    max_zoom=max_zoom,
    full_width=full_w,
    full_height=full_h,
    bounds_wgs84=bounds_wgs84,
    timesteps=timesteps,
    dt_hours=dt_hours,
    sim_start_iso=sim_start_iso,
    nodata=args.nodata,
    interp_k=interp_k,
    idw_power=float(args.idw_power),
    value_dtype=args.value_dtype,
    grid_width=grid_width,
    grid_mode=grid_mode,
  )

  (output_dir / "tile_geometries.json").write_text(
    json.dumps(tile_geometries),
    encoding="utf-8",
  )
  print(f"Wrote temporal tiles to {output_dir}")


if __name__ == "__main__":
  main()
