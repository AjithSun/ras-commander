"""
Build a tile_grid_v1 dataset for web-compare from raster scenarios.

This script writes:
1) metadata.json
2) float tile binaries at data/tiles/{scenario}/{variable}/{z}/{x}/{y}.bin

Tile binary format:
- width: uint16
- height: uint16
- nodata: float32
- values: float32[width * height], row-major

Example:
python scripts/prepare_data.py ^
  --scenario existing=C:\\path\\existing\\WSE (Max).vrt ^
  --scenario alt1=C:\\path\\Alt1\\WSE (Max).vrt
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import rasterio
from affine import Affine
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.warp import reproject

NODATA_DEFAULT = -9999.0


@dataclass(frozen=True)
class ScenarioInput:
  name: str
  raster_path: Path


def parse_scenario(spec: str) -> ScenarioInput:
  if '=' not in spec:
    raise ValueError(
      f"Invalid --scenario '{spec}'. Expected NAME=PATH.",
    )
  name, raw_path = spec.split('=', 1)
  name = name.strip()
  if not name:
    raise ValueError(f"Scenario name cannot be empty in '{spec}'.")
  path = Path(raw_path.strip())
  return ScenarioInput(name=name, raster_path=path)


def write_tile(path: Path, tile_values: np.ndarray, nodata: float) -> None:
  height, width = tile_values.shape
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open('wb') as f:
    f.write(struct.pack('<HHf', width, height, float(nodata)))
    f.write(tile_values.astype(np.float32, copy=False).tobytes(order='C'))


def get_max_zoom(width: int, height: int, tile_size: int) -> int:
  ratio = max(width, height) / tile_size
  if ratio <= 1:
    return 0
  return math.ceil(math.log2(ratio))


def get_level_shape(
  full_width: int,
  full_height: int,
  tile_size: int,
  max_zoom: int,
  z: int,
) -> Tuple[int, int, int, int, int]:
  scale = 2 ** (max_zoom - z)
  level_width = math.ceil(full_width / scale)
  level_height = math.ceil(full_height / scale)
  tiles_x = math.ceil(level_width / tile_size)
  tiles_y = math.ceil(level_height / tile_size)
  return level_width, level_height, tiles_x, tiles_y, scale


def project_tile_corners(
  level_transform: Affine,
  x0: int,
  y0: int,
  tile_w: int,
  tile_h: int,
  transformer: Transformer,
) -> List[float]:
  corners_px = [
    (x0, y0),
    (x0 + tile_w, y0),
    (x0 + tile_w, y0 + tile_h),
    (x0, y0 + tile_h),
  ]
  projected: List[float] = []
  for px, py in corners_px:
    src_x, src_y = level_transform * (px, py)
    lng, lat = transformer.transform(src_x, src_y)
    projected.extend([round(float(lng), 10), round(float(lat), 10)])
  return projected


def compute_bounds_wgs84(
  dataset: rasterio.io.DatasetReader,
) -> Tuple[float, float, float, float]:
  if dataset.crs is None:
    raise ValueError("Reference raster has no CRS.")
  transformer = Transformer.from_crs(dataset.crs, 4326, always_xy=True)
  left, bottom, right, top = dataset.bounds
  xs = [left, right, left, right]
  ys = [bottom, bottom, top, top]
  lngs, lats = transformer.transform(xs, ys)
  return min(lngs), min(lats), max(lngs), max(lats)


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
    '--scenario',
    action='append',
    required=True,
    help='Scenario input in NAME=RASTER_PATH format. Repeat per scenario.',
  )
  parser.add_argument(
    '--output-dir',
    type=Path,
    default=Path(__file__).resolve().parent.parent / 'data',
    help='Output directory for metadata and tiles.',
  )
  parser.add_argument(
    '--variable',
    default='maximum_water_surface',
    help='Variable key name in metadata.',
  )
  parser.add_argument(
    '--tile-size',
    type=int,
    default=256,
    help='Tile pixel width/height.',
  )
  parser.add_argument(
    '--min-zoom',
    type=int,
    default=0,
    help='Minimum pyramid zoom level.',
  )
  parser.add_argument(
    '--max-zoom',
    type=int,
    default=None,
    help='Maximum pyramid zoom level. Defaults to full native resolution.',
  )
  parser.add_argument(
    '--resampling',
    choices=['nearest', 'bilinear', 'average'],
    default='nearest',
    help='Resampling method for overview levels.',
  )
  parser.add_argument(
    '--clean',
    action='store_true',
    help='Delete existing tile outputs before writing.',
  )
  args = parser.parse_args()

  scenarios = [parse_scenario(spec) for spec in args.scenario]
  names = [s.name for s in scenarios]
  if len(set(names)) != len(names):
    raise ValueError('Scenario names must be unique.')

  for scenario in scenarios:
    if not scenario.raster_path.exists():
      raise FileNotFoundError(f"Raster not found: {scenario.raster_path}")

  output_dir = args.output_dir
  tiles_root = output_dir / 'tiles'
  metadata_path = output_dir / 'metadata.json'
  tile_geom_path = output_dir / 'tile_geometries.json'
  if args.clean:
    if tiles_root.exists():
      shutil.rmtree(tiles_root)
    if metadata_path.exists():
      metadata_path.unlink()
    if tile_geom_path.exists():
      tile_geom_path.unlink()
  output_dir.mkdir(parents=True, exist_ok=True)

  resampling_map = {
    'nearest': Resampling.nearest,
    'bilinear': Resampling.bilinear,
    'average': Resampling.average,
  }
  resampling = resampling_map[args.resampling]

  stats: Dict[str, Dict[str, float]] = {}

  with ExitStack() as stack:
    opened = {
      s.name: stack.enter_context(rasterio.open(s.raster_path))
      for s in scenarios
    }
    reference = opened[scenarios[0].name]
    if reference.crs is None:
      raise ValueError('Reference raster must define CRS.')

    full_width = reference.width
    full_height = reference.height
    reference_transform = reference.transform
    reference_crs = reference.crs
    nodata = (
      float(reference.nodata)
      if reference.nodata is not None else NODATA_DEFAULT
    )

    max_zoom = args.max_zoom
    if max_zoom is None:
      max_zoom = get_max_zoom(full_width, full_height, args.tile_size)
    if args.min_zoom < 0 or max_zoom < args.min_zoom:
      raise ValueError(
        f"Invalid zoom range: min={args.min_zoom}, max={max_zoom}",
      )

    west, south, east, north = compute_bounds_wgs84(reference)
    to_wgs84 = Transformer.from_crs(reference_crs, 4326, always_xy=True)
    tile_geometries: Dict[str, List[float]] = {}

    print(
      f"Reference grid: {full_width}x{full_height}, "
      f"tile_size={args.tile_size}, zoom={args.min_zoom}..{max_zoom}",
    )

    for scenario in scenarios:
      ds = opened[scenario.name]
      if ds.crs is None:
        raise ValueError(f"Scenario {scenario.name} has no CRS.")
      src_nodata = float(ds.nodata) if ds.nodata is not None else nodata
      src_band = rasterio.band(ds, 1)

      scenario_min = math.inf
      scenario_max = -math.inf
      print(f"\nScenario: {scenario.name}")

      for z in range(args.min_zoom, max_zoom + 1):
        level_w, level_h, tiles_x, tiles_y, scale = get_level_shape(
          full_width,
          full_height,
          args.tile_size,
          max_zoom,
          z,
        )
        level_transform = reference_transform * Affine.scale(scale, scale)
        tile_count = tiles_x * tiles_y
        print(
          f"  z={z}: level={level_w}x{level_h}, tiles={tiles_x}x{tiles_y} "
          f"({tile_count})",
        )

        for ty in range(tiles_y):
          for tx in range(tiles_x):
            x0 = tx * args.tile_size
            y0 = ty * args.tile_size
            tile_w = min(args.tile_size, level_w - x0)
            tile_h = min(args.tile_size, level_h - y0)
            dst_transform = level_transform * Affine.translation(x0, y0)
            tile_key = f'{z}/{tx}/{ty}'
            if tile_key not in tile_geometries:
              tile_geometries[tile_key] = project_tile_corners(
                level_transform=level_transform,
                x0=x0,
                y0=y0,
                tile_w=tile_w,
                tile_h=tile_h,
                transformer=to_wgs84,
              )

            tile_arr = np.full((tile_h, tile_w), nodata, dtype=np.float32)
            reproject(
              source=src_band,
              destination=tile_arr,
              src_transform=ds.transform,
              src_crs=ds.crs,
              src_nodata=src_nodata,
              dst_transform=dst_transform,
              dst_crs=reference_crs,
              dst_nodata=nodata,
              resampling=resampling,
            )

            valid_mask = ~np.isclose(tile_arr, nodata)
            if not np.any(valid_mask):
              continue

            out_path = (
              tiles_root
              / scenario.name
              / args.variable
              / str(z)
              / str(tx)
              / f'{ty}.bin'
            )
            write_tile(out_path, tile_arr, nodata)

            if z == max_zoom:
              valid_vals = tile_arr[valid_mask]
              if valid_vals.size > 0:
                tile_min = float(valid_vals.min())
                tile_max = float(valid_vals.max())
                scenario_min = min(scenario_min, tile_min)
                scenario_max = max(scenario_max, tile_max)

      if not math.isfinite(scenario_min):
        scenario_min = 0.0
        scenario_max = 1.0
      stats[scenario.name] = {'min': scenario_min, 'max': scenario_max}
      print(
        f"  stats: min={scenario_min:.3f}, max={scenario_max:.3f}",
      )

    metadata = {
      'format': 'tile_grid_v1',
      'nodata': nodata,
      'tile_grid': {
        'tile_size': args.tile_size,
        'min_zoom': args.min_zoom,
        'max_zoom': max_zoom,
        'full_width': full_width,
        'full_height': full_height,
        'bounds': [west, south, east, north],
        'tile_geometries_file': 'tile_geometries.json',
      },
      'variables': [args.variable],
      'scenarios': {
        s.name: {
          'source_file': str(s.raster_path),
          'variables': {
            args.variable: {
              'path_template':
                f"tiles/{s.name}/{args.variable}/{{z}}/{{x}}/{{y}}.bin",
              'min': round(stats[s.name]['min'], 3),
              'max': round(stats[s.name]['max'], 3),
            },
          },
        }
        for s in scenarios
      },
    }

    metadata_path.write_text(
      json.dumps(metadata, indent=2),
      encoding='utf-8',
    )
    tile_geom_path.write_text(
      json.dumps(tile_geometries),
      encoding='utf-8',
    )
    print(f"\nWrote {metadata_path}")
    print(f"Wrote {tile_geom_path}")
    print('Done.')


if __name__ == '__main__':
  main()
