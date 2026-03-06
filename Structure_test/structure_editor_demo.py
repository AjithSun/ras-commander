"""
HEC-RAS Structure Editor - Interactive CLI Tool

Self-contained Python script for viewing and editing structures 
in HEC-RAS geometry files using the ras-commander API.

Usage:
    python structure_editor_demo.py <geometry_file> [options]
    
Examples:
    python structure_editor_demo.py model.g01
    python structure_editor_demo.py model.g01 --list-xs
    python structure_editor_demo.py model.g01 --xs "River/Reach/1000"
    python structure_editor_demo.py model.g01 --list-bridges
    python structure_editor_demo.py model.g01 --bridge "River/Reach/25548"
"""

import sys
import argparse
from pathlib import Path
import pandas as pd

# Add ras-commander to path for development mode
sys.path.insert(0, str(Path(__file__).parent.parent))

from ras_commander import (
    GeomBridge,
    GeomCulvert,
    GeomInlineWeir,
    GeomLateral,
    GeomStorage,
    GeomCrossSection,
    HdfStruc,
)

# Display settings
pd.set_option('display.max_columns', None)
pd.set_option('display.width', None)
pd.set_option('display.max_colwidth', 50)


def print_header(title: str):
    """Print a formatted section header."""
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


def print_subheader(title: str):
    """Print a formatted subsection header."""
    print(f"\n--- {title} ---")


def safe_print_df(df: pd.DataFrame, max_rows: int = 20):
    """Safely print a DataFrame with row limit."""
    if df is None or df.empty:
        print("  (No data available)")
        return
    
    if len(df) > max_rows:
        print(f"  Showing first {max_rows} of {len(df)} rows:")
        print(df.head(max_rows).to_string(index=False))
    else:
        print(df.to_string(index=False))


def parse_location(location_str: str):
    """Parse 'River/Reach/RS' string into components."""
    parts = location_str.split('/')
    if len(parts) != 3:
        raise ValueError(f"Location must be in format 'River/Reach/RS', got: {location_str}")
    return parts[0], parts[1], parts[2]


# ============================================================================
# Cross Section Operations
# ============================================================================

def list_cross_sections(geom_file: Path):
    """List all cross sections in geometry file."""
    print_header("CROSS SECTIONS")
    
    try:
        xs_df = GeomCrossSection.get_cross_sections(geom_file)
        if xs_df.empty:
            print("  No cross sections found.")
            return
        
        print(f"  Found {len(xs_df)} cross section(s):\n")
        safe_print_df(xs_df)
        
        print("\n  To view/edit a specific cross section, use:")
        print(f"    python {sys.argv[0]} {geom_file} --xs \"River/Reach/RS\"")
        
    except Exception as e:
        print(f"  Error: {e}")


def show_cross_section(geom_file: Path, river: str, reach: str, rs: str):
    """Show detailed cross section data with editable fields."""
    print_header(f"CROSS SECTION: {river}/{reach}/RS {rs}")
    
    # 1. Station/Elevation
    print_subheader("Station/Elevation Profile (EDITABLE)")
    try:
        sta_elev = GeomCrossSection.get_station_elevation(geom_file, river, reach, rs)
        safe_print_df(sta_elev)
        
        print("\n  EDIT with GeomCrossSection.set_station_elevation():")
        print(f"""
    import pandas as pd
    from ras_commander import GeomCrossSection
    
    new_data = pd.DataFrame({{
        'Station': [0, 50, 100, 150, 200],
        'Elevation': [505, 500, 498, 500, 505]
    }})
    
    GeomCrossSection.set_station_elevation(
        geom_file=r"{geom_file}",
        river="{river}",
        reach="{reach}",
        rs="{rs}",
        sta_elev_df=new_data,
        bank_left=50.0,    # Optional: will interpolate if not in data
        bank_right=150.0   # Optional: will interpolate if not in data
    )
""")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 2. Bank Stations
    print_subheader("Bank Stations (READ-ONLY)")
    try:
        banks = GeomCrossSection.get_bank_stations(geom_file, river, reach, rs)
        if banks:
            left, right = banks
            print(f"  Left Bank Station:  {left}")
            print(f"  Right Bank Station: {right}")
            print(f"  Main Channel Width: {right - left:.2f}")
        else:
            print("  No bank stations defined.")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 3. Manning's n
    print_subheader("Manning's n Values (READ-ONLY)")
    try:
        mannings = GeomCrossSection.get_mannings_n(geom_file, river, reach, rs)
        safe_print_df(mannings)
    except Exception as e:
        print(f"  Error: {e}")
    
    # 4. Expansion/Contraction
    print_subheader("Expansion/Contraction Coefficients (READ-ONLY)")
    try:
        coeffs = GeomCrossSection.get_expansion_contraction(geom_file, river, reach, rs)
        if coeffs:
            exp, cont = coeffs
            print(f"  Expansion:    {exp}")
            print(f"  Contraction:  {cont}")
        else:
            print("  No coefficients defined.")
    except Exception as e:
        print(f"  Error: {e}")


# ============================================================================
# Bridge Operations
# ============================================================================

def list_bridges(geom_file: Path):
    """List all bridges in geometry file."""
    print_header("BRIDGES")
    
    try:
        bridges_df = GeomBridge.get_bridges(geom_file)
        if bridges_df.empty:
            print("  No bridges found.")
            return
        
        print(f"  Found {len(bridges_df)} bridge(s):\n")
        safe_print_df(bridges_df)
        
        print("\n  To view a specific bridge, use:")
        print(f"    python {sys.argv[0]} {geom_file} --bridge \"River/Reach/RS\"")
        
    except Exception as e:
        print(f"  Error: {e}")


def show_bridge(geom_file: Path, river: str, reach: str, rs: str):
    """Show detailed bridge data."""
    print_header(f"BRIDGE: {river}/{reach}/RS {rs}")
    
    # 1. Deck geometry
    print_subheader("Deck Geometry (READ-ONLY)")
    try:
        deck_df = GeomBridge.get_deck(geom_file, river, reach, rs)
        safe_print_df(deck_df)
    except ValueError as e:
        print(f"  {e}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 2. Piers
    print_subheader("Pier Definitions (READ-ONLY)")
    try:
        piers_df = GeomBridge.get_piers(geom_file, river, reach, rs)
        safe_print_df(piers_df)
    except ValueError as e:
        print(f"  {e}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 3. Abutments
    print_subheader("Abutment Geometry (READ-ONLY)")
    try:
        abutment_df = GeomBridge.get_abutment(geom_file, river, reach, rs)
        safe_print_df(abutment_df)
    except ValueError as e:
        print(f"  {e}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 4. Approach sections
    print_subheader("Approach Sections - BR U/BR D (READ-ONLY)")
    try:
        approach_df = GeomBridge.get_approach_sections(geom_file, river, reach, rs)
        
        upstream = approach_df[(approach_df['Location'] == 'upstream') & 
                               (approach_df['DataType'] == 'station_elevation')]
        downstream = approach_df[(approach_df['Location'] == 'downstream') & 
                                  (approach_df['DataType'] == 'station_elevation')]
        
        print(f"  Upstream section ({len(upstream)} points):")
        safe_print_df(upstream[['Station', 'Elevation']])
        
        print(f"\n  Downstream section ({len(downstream)} points):")
        safe_print_df(downstream[['Station', 'Elevation']])
    except ValueError as e:
        print(f"  {e}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 5. Coefficients
    print_subheader("Hydraulic Coefficients (READ-ONLY)")
    try:
        coeffs_df = GeomBridge.get_coefficients(geom_file, river, reach, rs)
        safe_print_df(coeffs_df)
    except ValueError as e:
        print(f"  {e}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # 6. HTab
    print_subheader("HTab Parameters (READ-ONLY)")
    try:
        htab_df = GeomBridge.get_htab(geom_file, river, reach, rs)
        safe_print_df(htab_df)
    except ValueError as e:
        print(f"  {e}")
    except Exception as e:
        print(f"  Error: {e}")


# ============================================================================
# Storage Area Operations
# ============================================================================

def list_storage_areas(geom_file: Path):
    """List all storage areas in geometry file."""
    print_header("STORAGE AREAS")
    
    try:
        storage_df = GeomStorage.get_storage_areas(geom_file)
        if storage_df.empty:
            print("  No storage areas found.")
            return
        
        print(f"  Found {len(storage_df)} storage area(s):\n")
        safe_print_df(storage_df)
        
        print("\n  To view/edit a specific storage area, use:")
        print(f"    python {sys.argv[0]} {geom_file} --storage \"StorageAreaName\"")
        
    except Exception as e:
        print(f"  Error: {e}")


def show_storage_area(geom_file: Path, storage_name: str):
    """Show storage area data with editable fields."""
    print_header(f"STORAGE AREA: {storage_name}")
    
    print_subheader("Elevation-Volume Curve (EDITABLE)")
    try:
        elev_vol = GeomStorage.get_elevation_volume(geom_file, storage_name)
        safe_print_df(elev_vol)
        
        if not elev_vol.empty:
            print(f"\n  Summary:")
            print(f"    Min Elevation: {elev_vol['Elevation'].min():.2f}")
            print(f"    Max Elevation: {elev_vol['Elevation'].max():.2f}")
            print(f"    Max Volume:    {elev_vol['Volume'].max():,.0f}")
        
        print("\n  EDIT with GeomStorage.set_elevation_volume():")
        print(f"""
    from ras_commander import GeomStorage
    
    GeomStorage.set_elevation_volume(
        geom_file=r"{geom_file}",
        storage_name="{storage_name}",
        elevations=[100.0, 110.0, 120.0, 130.0, 140.0],
        volumes=[0, 1000, 5000, 15000, 30000],
        create_backup=True  # Creates .bak file before modifying
    )
""")
    except Exception as e:
        print(f"  Error: {e}")


# ============================================================================
# Other Structure Operations
# ============================================================================

def list_inline_weirs(geom_file: Path):
    """List all inline weirs."""
    print_header("INLINE WEIRS")
    
    try:
        weirs_df = GeomInlineWeir.get_weirs(geom_file)
        if weirs_df.empty:
            print("  No inline weirs found.")
            return
        
        print(f"  Found {len(weirs_df)} inline weir(s):\n")
        safe_print_df(weirs_df)
        
    except Exception as e:
        print(f"  Error: {e}")


def list_lateral_structures(geom_file: Path):
    """List all lateral structures."""
    print_header("LATERAL STRUCTURES")
    
    try:
        laterals_df = GeomLateral.get_lateral_structures(geom_file)
        if laterals_df.empty:
            print("  No lateral structures found.")
        else:
            print(f"  Found {len(laterals_df)} lateral structure(s):\n")
            safe_print_df(laterals_df)
    except Exception as e:
        print(f"  Error: {e}")
    
    print_subheader("SA/2D Connections")
    try:
        connections_df = GeomLateral.get_connections(geom_file)
        if connections_df.empty:
            print("  No SA/2D connections found.")
        else:
            print(f"  Found {len(connections_df)} connection(s):\n")
            safe_print_df(connections_df)
    except Exception as e:
        print(f"  Error: {e}")


def list_culverts(geom_file: Path):
    """List all culverts."""
    print_header("CULVERTS")
    
    try:
        culverts_df = GeomCulvert.get_all(geom_file)
        if culverts_df.empty:
            print("  No culverts found.")
            return
        
        print(f"  Found {len(culverts_df)} culvert(s):\n")
        safe_print_df(culverts_df)
        
    except Exception as e:
        print(f"  Error: {e}")


def show_all(geom_file: Path):
    """Show summary of all structures in geometry file."""
    print_header("GEOMETRY FILE SUMMARY")
    print(f"  File: {geom_file}")
    
    # Cross sections
    print_subheader("Cross Sections")
    try:
        xs_df = GeomCrossSection.get_cross_sections(geom_file)
        print(f"  Count: {len(xs_df)}")
        if not xs_df.empty:
            print(f"  Rivers: {', '.join(xs_df['River'].unique())}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Bridges
    print_subheader("Bridges")
    try:
        bridges_df = GeomBridge.get_bridges(geom_file)
        print(f"  Count: {len(bridges_df)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Culverts
    print_subheader("Culverts")
    try:
        culverts_df = GeomCulvert.get_all(geom_file)
        print(f"  Count: {len(culverts_df)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Inline weirs
    print_subheader("Inline Weirs")
    try:
        weirs_df = GeomInlineWeir.get_weirs(geom_file)
        print(f"  Count: {len(weirs_df)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Lateral structures
    print_subheader("Lateral Structures")
    try:
        laterals_df = GeomLateral.get_lateral_structures(geom_file)
        print(f"  Count: {len(laterals_df)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Connections
    print_subheader("SA/2D Connections")
    try:
        connections_df = GeomLateral.get_connections(geom_file)
        print(f"  Count: {len(connections_df)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Storage areas
    print_subheader("Storage Areas")
    try:
        storage_df = GeomStorage.get_storage_areas(geom_file)
        print(f"  Count: {len(storage_df)}")
    except Exception as e:
        print(f"  Error: {e}")
    
    # Editable summary
    print_header("EDITABLE FIELDS (via ras-commander)")
    print("""
  The following structure data can be EDITED programmatically:
  
  1. CROSS SECTIONS - Station/Elevation Profile
     GeomCrossSection.set_station_elevation(geom_file, river, reach, rs, sta_elev_df)
     
  2. STORAGE AREAS - Elevation/Volume Curve  
     GeomStorage.set_elevation_volume(geom_file, storage_name, elevations, volumes)
  
  All other structure data is currently READ-ONLY through the ras-commander API.
  
  Use the options below to view specific structures:
    --list-xs        List all cross sections
    --list-bridges   List all bridges
    --list-storage   List all storage areas
    --list-weirs     List all inline weirs
    --list-laterals  List all lateral structures
    --list-culverts  List all culverts
    
    --xs "River/Reach/RS"       View/edit cross section
    --bridge "River/Reach/RS"   View bridge details
    --storage "Name"            View/edit storage area
""")


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="HEC-RAS Structure Editor - View and edit structures using ras-commander",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s model.g01                          Show summary of all structures
  %(prog)s model.g01 --list-xs                List all cross sections
  %(prog)s model.g01 --xs "River/Reach/1000"  View cross section details
  %(prog)s model.g01 --list-bridges           List all bridges
  %(prog)s model.g01 --bridge "River/Reach/500" View bridge details
  %(prog)s model.g01 --list-storage           List all storage areas
  %(prog)s model.g01 --storage "Reservoir"    View storage area details
        """
    )
    
    parser.add_argument("geom_file", type=Path, help="Path to HEC-RAS geometry file (.g##)")
    
    # List options
    parser.add_argument("--list-xs", action="store_true", help="List all cross sections")
    parser.add_argument("--list-bridges", action="store_true", help="List all bridges")
    parser.add_argument("--list-storage", action="store_true", help="List all storage areas")
    parser.add_argument("--list-weirs", action="store_true", help="List all inline weirs")
    parser.add_argument("--list-laterals", action="store_true", help="List all lateral structures")
    parser.add_argument("--list-culverts", action="store_true", help="List all culverts")
    
    # View specific structure
    parser.add_argument("--xs", type=str, metavar="RIVER/REACH/RS",
                        help="View/edit cross section at specified location")
    parser.add_argument("--bridge", type=str, metavar="RIVER/REACH/RS",
                        help="View bridge at specified location")
    parser.add_argument("--storage", type=str, metavar="NAME",
                        help="View/edit storage area by name")
    
    args = parser.parse_args()
    
    # Validate geometry file
    if not args.geom_file.exists():
        print(f"ERROR: Geometry file not found: {args.geom_file}")
        return 1
    
    # Handle list options
    if args.list_xs:
        list_cross_sections(args.geom_file)
        return 0
    
    if args.list_bridges:
        list_bridges(args.geom_file)
        return 0
    
    if args.list_storage:
        list_storage_areas(args.geom_file)
        return 0
    
    if args.list_weirs:
        list_inline_weirs(args.geom_file)
        return 0
    
    if args.list_laterals:
        list_lateral_structures(args.geom_file)
        return 0
    
    if args.list_culverts:
        list_culverts(args.geom_file)
        return 0
    
    # Handle view specific structure
    if args.xs:
        try:
            river, reach, rs = parse_location(args.xs)
            show_cross_section(args.geom_file, river, reach, rs)
            return 0
        except ValueError as e:
            print(f"ERROR: {e}")
            return 1
    
    if args.bridge:
        try:
            river, reach, rs = parse_location(args.bridge)
            show_bridge(args.geom_file, river, reach, rs)
            return 0
        except ValueError as e:
            print(f"ERROR: {e}")
            return 1
    
    if args.storage:
        show_storage_area(args.geom_file, args.storage)
        return 0
    
    # Default: show summary
    show_all(args.geom_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
