import 'maplibre-gl/dist/maplibre-gl.css';
import { loadMetadata, loadTileCornerIndex } from './data/loader';
import type { DisplayMode, Metadata } from './data/types';
import { createMap } from './map/map-setup';
import { TileManager } from './map/tile-manager';
import { TileOverlayRenderer, type TileOverlayState } from './map/tile-overlay';
import { initControls, type ControlState } from './ui/controls';
import { setupHoverInspector } from './ui/info';
import { updateLegend } from './ui/legend';

const loading = document.getElementById('loading');

async function main(): Promise<void> {
  try {
    const metadata = await loadMetadata();
    const tileCorners = await loadTileCornerIndex(metadata);
    const [west, south, east, north] = metadata.tile_grid.bounds;
    const map = createMap('map', { west, south, east, north });
    const tileManager = new TileManager(metadata, tileCorners);

    let overlay: TileOverlayRenderer | null = null;
    let currentControls: ControlState;
    let currentMode: DisplayMode = 'diff';

    const initial = initControls(metadata, (state) => {
      currentControls = state;
      if (!overlay) return;
      applyState(metadata, overlay, state);
      currentMode = state.mode;
      map.triggerRepaint();
    });
    currentControls = initial;

    map.on('load', () => {
      const initialOverlayState = toOverlayState(metadata, initial);
      overlay = new TileOverlayRenderer(map, metadata, tileManager, initialOverlayState);
      applyState(metadata, overlay, initial);
      currentMode = initial.mode;

      setupHoverInspector(
        map,
        overlay,
        () => currentMode,
        () => currentControls.metric,
      );
      loading?.classList.add('hidden');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (loading) {
      loading.classList.remove('hidden');
      loading.innerHTML = `<p style="max-width:420px;text-align:center;padding:20px">WebGPU startup failed: ${message}</p>`;
    }
    throw err;
  }
}

function applyState(
  metadata: Metadata,
  overlay: TileOverlayRenderer,
  controlState: ControlState,
): void {
  const overlayState = toOverlayState(metadata, controlState);
  overlay.updateState(overlayState);
  updateLegend(
    controlState.mode,
    controlState.metric,
    overlayState.valueMin,
    overlayState.valueMax,
  );
}

function toOverlayState(
  metadata: Metadata,
  controlState: ControlState,
): TileOverlayState {
  const simHours = metadata.temporal.simulation_duration_hours;
  const metricRange = metadata.metric_ranges_hours[controlState.metric] ?? [0, simHours];
  const [valueMin, valueMax] = getDisplayRange(controlState.mode, metricRange[0], metricRange[1]);

  return {
    scenarioA: controlState.scenarioA,
    scenarioB: controlState.scenarioB,
    variable: controlState.variable,
    metric: controlState.metric,
    mode: controlState.mode,
    threshold: controlState.threshold,
    valueMin,
    valueMax,
    opacity: controlState.opacity,
  };
}

function getDisplayRange(
  mode: 'a' | 'b' | 'diff',
  metricMin: number,
  metricMax: number,
): [number, number] {
  if (mode === 'diff') {
    const maxAbs = Math.max(Math.abs(metricMin), Math.abs(metricMax), 0.1);
    return [-maxAbs, maxAbs];
  }
  return [metricMin, metricMax];
}

void main();
