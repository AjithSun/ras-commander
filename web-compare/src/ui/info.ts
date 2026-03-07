import type maplibregl from 'maplibre-gl';
import type { DisplayMode, MetricKind } from '../data/types';
import type { TileOverlayRenderer } from '../map/tile-overlay';

export function setupHoverInspector(
  map: maplibregl.Map,
  overlay: TileOverlayRenderer,
  getMode: () => DisplayMode,
  getMetric: () => MetricKind,
): void {
  const infoText = document.getElementById('info-text');
  if (!infoText) return;

  map.on('mousemove', (e) => {
    const { lng, lat } = e.lngLat;
    const sample = overlay.sampleAtLngLat(lng, lat);
    if (!sample) {
      infoText.textContent = 'Hover over inundation tiles to inspect';
      return;
    }

    const metric = getMetric().replaceAll('_', ' ');
    const fmtA = sample.nodataA ? 'N/A' : `${sample.metricA.toFixed(2)} h`;
    const fmtB = sample.nodataB ? 'N/A' : `${sample.metricB.toFixed(2)} h`;
    const fmtD = (sample.nodataA || sample.nodataB)
      ? 'N/A'
      : `${sample.diff >= 0 ? '+' : ''}${sample.diff.toFixed(2)} h`;

    const mode = getMode();
    if (mode === 'diff') {
      infoText.innerHTML = `${metric} A: ${fmtA} | B: ${fmtB} | <b>Diff: ${fmtD}</b>`;
    } else if (mode === 'b') {
      infoText.innerHTML = `${metric} B: <b>${fmtB}</b>`;
    } else {
      infoText.innerHTML = `${metric} A: <b>${fmtA}</b>`;
    }
  });
}
