import type maplibregl from 'maplibre-gl';
import type { DisplayMode } from '../data/types';
import type { TileOverlayRenderer } from '../map/tile-overlay';

export function setupHoverInspector(
  map: maplibregl.Map,
  overlay: TileOverlayRenderer,
  getMode: () => DisplayMode,
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

    const fmtA = sample.nodataA ? 'N/A' : sample.valueA.toFixed(2);
    const fmtB = sample.nodataB ? 'N/A' : sample.valueB.toFixed(2);
    const fmtD = (sample.nodataA || sample.nodataB)
      ? 'N/A'
      : `${sample.diff >= 0 ? '+' : ''}${sample.diff.toFixed(2)}`;

    const mode = getMode();
    if (mode === 'diff') {
      infoText.innerHTML = `A: ${fmtA} | B: ${fmtB} | <b>Diff: ${fmtD}</b>`;
    } else if (mode === 'b') {
      infoText.innerHTML = `Scenario B: <b>${fmtB}</b>`;
    } else {
      infoText.innerHTML = `Scenario A: <b>${fmtA}</b>`;
    }
  });
}
