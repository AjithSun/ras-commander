"""
Export HEC-RAS 2D mesh geometry + results to WebGPU-optimized binary format.

Reads HDF files directly with h5py, reprojects to EPSG:4326, triangulates
mesh cell polygons, and writes compact binary files for the web app.

Usage:
    python scripts/prepare_data.py
"""

import json
import struct
import sys
from pathlib import Path

import h5py
import numpy as np

try:
    from pyproj import Transformer
except ImportError:
    sys.exit("pyproj required: pip install pyproj")

# ─── Configuration ───────────────────────────────────────────────────────────

HDF_DIR = Path(r"C:\Users\ajith\Documents\KDD_2D")
GEOM_HDF = HDF_DIR / "HCFCD_Final.g01.hdf"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data"

SCENARIOS = {
    "existing": "HCFCD_Final.p04.hdf",
    "alt1": "HCFCD_Final.p08.hdf",
    "alt2": "HCFCD_Final.p12.hdf",
    "alt3": "HCFCD_Final.p16.hdf",
}

# Source CRS: NAD83 Texas South Central (US Survey Feet)
SRC_EPSG = 2278
DST_EPSG = 4326

MESH_AREA = "Geometry/2D Flow Areas/Perimeter 1"
RESULTS_BASE = "Results/Unsteady/Output/Output Blocks/Base Output/Summary Output/2D Flow Areas/Perimeter 1"

NODATA = -9999.0


# ─── Geometry extraction ─────────────────────────────────────────────────────

def load_mesh_geometry(geom_hdf_path: Path):
    """Load cell polygons from geometry HDF, reproject to WGS84."""
    print(f"Reading geometry from {geom_hdf_path.name}...")
    transformer = Transformer.from_crs(SRC_EPSG, DST_EPSG, always_xy=True)

    with h5py.File(geom_hdf_path, "r") as f:
        fp_coords = f[f"{MESH_AREA}/FacePoints Coordinate"][:]  # (N_fp, 2)
        cell_fp_idx = f[f"{MESH_AREA}/Cells FacePoint Indexes"][:]  # (N_cells, 8)

    num_cells = cell_fp_idx.shape[0]
    num_fp = fp_coords.shape[0]
    print(f"  {num_cells} cells, {num_fp} face points")

    # Reproject all face points at once
    lngs, lats = transformer.transform(fp_coords[:, 0], fp_coords[:, 1])
    fp_wgs84 = np.column_stack([lngs, lats]).astype(np.float32)

    return fp_wgs84, cell_fp_idx, num_cells


def triangulate_mesh(fp_wgs84: np.ndarray, cell_fp_idx: np.ndarray, num_cells: int):
    """Fan-triangulate each cell polygon. Returns vertices, triangles, cell_map."""
    print("Triangulating mesh cells...")

    # Collect unique vertices and build triangles via fan triangulation
    # Each cell is a polygon defined by its face points (up to 8, -1 = unused)
    all_tri_verts = []  # (v0, v1, v2) as fp indices
    all_tri_cells = []  # which cell each triangle belongs to

    for cell_id in range(num_cells):
        fp_ids = cell_fp_idx[cell_id]
        # Filter out -1 padding
        valid = fp_ids[fp_ids >= 0]
        n = len(valid)
        if n < 3:
            continue
        # Fan triangulation from first vertex
        for j in range(1, n - 1):
            all_tri_verts.append((valid[0], valid[j], valid[j + 1]))
            all_tri_cells.append(cell_id)

    triangles = np.array(all_tri_verts, dtype=np.uint32)
    cell_map = np.array(all_tri_cells, dtype=np.uint32)

    print(f"  {len(triangles)} triangles from {num_cells} cells")
    return triangles, cell_map


def write_mesh_binary(fp_wgs84: np.ndarray, triangles: np.ndarray,
                      cell_map: np.ndarray, output_path: Path):
    """Write mesh.bin: header + vertices + triangles + cell_map."""
    num_vertices = len(fp_wgs84)
    num_triangles = len(triangles)

    # Compute bounds
    west = float(fp_wgs84[:, 0].min())
    south = float(fp_wgs84[:, 1].min())
    east = float(fp_wgs84[:, 0].max())
    north = float(fp_wgs84[:, 1].max())

    print(f"  Bounds: [{west:.6f}, {south:.6f}, {east:.6f}, {north:.6f}]")

    with open(output_path, "wb") as out:
        # Header: num_vertices(u32) + num_triangles(u32) + bounds(4×f64)
        out.write(struct.pack("<II", num_vertices, num_triangles))
        out.write(struct.pack("<4d", west, south, east, north))

        # Vertices: float32[num_vertices * 2] (lng, lat interleaved)
        out.write(fp_wgs84.astype(np.float32).tobytes())

        # Triangles: uint32[num_triangles * 3]
        out.write(triangles.astype(np.uint32).tobytes())

        # Cell map: uint32[num_triangles]
        out.write(cell_map.astype(np.uint32).tobytes())

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  Wrote {output_path.name} ({size_mb:.1f} MB)")

    return west, south, east, north


# ─── Results extraction ──────────────────────────────────────────────────────

def extract_max_values(plan_hdf_path: Path, num_cells: int):
    """Extract Maximum Water Surface and compute Maximum Depth from plan HDF."""
    print(f"  Reading results from {plan_hdf_path.name}...")
    results = {}

    with h5py.File(plan_hdf_path, "r") as f:
        # Maximum Water Surface: shape (2, N_cells) — row 0 = values, row 1 = time index
        max_ws_path = f"{RESULTS_BASE}/Maximum Water Surface"
        if max_ws_path in f:
            max_ws = f[max_ws_path][0, :]  # First row = values
            results["maximum_water_surface"] = max_ws.astype(np.float32)
        else:
            print(f"    WARNING: {max_ws_path} not found")
            results["maximum_water_surface"] = np.full(num_cells, NODATA, dtype=np.float32)

        # Minimum elevation (for depth = WSE - ground)
        min_elev_path = f"{MESH_AREA}/Cells Minimum Elevation"
        # Min elevation is in geometry HDF, but also sometimes in plan HDF
        # We'll compute depth separately

    # Read min elevation from geometry HDF
    with h5py.File(GEOM_HDF, "r") as f:
        min_elev = f[f"{MESH_AREA}/Cells Minimum Elevation"][:num_cells]

    max_ws = results["maximum_water_surface"]
    depth = np.where(
        (max_ws > NODATA + 1) & (max_ws > min_elev),
        max_ws - min_elev,
        0.0
    ).astype(np.float32)
    results["maximum_depth"] = depth

    return results


def write_values_binary(values: np.ndarray, output_path: Path):
    """Write per-cell values as binary: header + float32 array."""
    num_cells = len(values)
    with open(output_path, "wb") as out:
        out.write(struct.pack("<I", num_cells))
        out.write(struct.pack("<f", NODATA))
        out.write(values.astype(np.float32).tobytes())
    size_kb = output_path.stat().st_size / 1024
    print(f"    Wrote {output_path.name} ({size_kb:.0f} KB)")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Geometry
    fp_wgs84, cell_fp_idx, num_cells = load_mesh_geometry(GEOM_HDF)
    triangles, cell_map = triangulate_mesh(fp_wgs84, cell_fp_idx, num_cells)
    west, south, east, north = write_mesh_binary(
        fp_wgs84, triangles, cell_map, OUTPUT_DIR / "mesh.bin"
    )

    # Step 2: Results per scenario
    metadata = {
        "bounds": [west, south, east, north],
        "num_cells": num_cells,
        "nodata": NODATA,
        "scenarios": {},
        "variables": ["maximum_water_surface", "maximum_depth"],
    }

    for scenario_name, hdf_name in SCENARIOS.items():
        print(f"\nScenario: {scenario_name}")
        plan_path = HDF_DIR / hdf_name
        if not plan_path.exists():
            print(f"  WARNING: {plan_path} not found, skipping")
            continue

        results = extract_max_values(plan_path, num_cells)
        scenario_meta = {"file": hdf_name, "variables": {}}

        for var_name, values in results.items():
            valid = values[values > NODATA + 1]
            vmin = float(valid.min()) if len(valid) > 0 else 0.0
            vmax = float(valid.max()) if len(valid) > 0 else 1.0

            out_name = f"{scenario_name}_{var_name}.bin"
            write_values_binary(values, OUTPUT_DIR / out_name)

            scenario_meta["variables"][var_name] = {
                "file": out_name,
                "min": round(vmin, 3),
                "max": round(vmax, 3),
            }

        metadata["scenarios"][scenario_name] = scenario_meta

    # Step 3: Metadata
    meta_path = OUTPUT_DIR / "metadata.json"
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"\nWrote {meta_path.name}")
    print("Done!")


if __name__ == "__main__":
    main()
