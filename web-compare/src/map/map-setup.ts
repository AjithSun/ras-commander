import maplibregl from 'maplibre-gl';

export function createMap(
  container: string | HTMLElement,
  bounds: { west: number; south: number; east: number; north: number },
): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap contributors',
          maxzoom: 19,
        },
      },
      layers: [
        {
          id: 'osm-tiles',
          type: 'raster',
          source: 'osm',
          minzoom: 0,
          maxzoom: 19,
        },
      ],
    },
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north] as [number, number, number, number],
    fitBoundsOptions: { padding: 40 },
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 200 }), 'bottom-left');

  return map;
}
