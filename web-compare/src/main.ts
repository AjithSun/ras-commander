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
  const metadata = await loadMetadata();
  const tileCorners = await loadTileCornerIndex(metadata);
  const [west, south, east, north] = metadata.tile_grid.bounds;
  const map = createMap('map', { west, south, east, north });
  const tileManager = new TileManager(metadata, tileCorners);

  let overlay: TileOverlayRenderer | null = null;
  let currentMode: DisplayMode = 'diff';
  let currentControls: ControlState;
  let dynamicDiffRange: [number, number] | null = null;
  let lastDynamicTickMs = 0;

  const initial = initControls(metadata, (state) => {
    currentControls = state;
    dynamicDiffRange = null;
    if (!overlay) return;
    applyState(metadata, overlay, state, dynamicDiffRange);
    currentMode = state.mode;
    map.triggerRepaint();
  });
  currentControls = initial;

  map.on('load', () => {
    const initialOverlayState = toOverlayState(metadata, initial, dynamicDiffRange);
    overlay = new TileOverlayRenderer(map, metadata, tileManager, initialOverlayState);
    applyState(metadata, overlay, initial, dynamicDiffRange);
    currentMode = initial.mode;

    setupHoverInspector(map, overlay, () => currentMode);
    loading?.classList.add('hidden');

    map.on('render', () => {
      if (!overlay) return;
      if (currentControls.mode !== 'diff' || !currentControls.autoDiffScale) return;

      const now = performance.now();
      if (now - lastDynamicTickMs < 250) return;
      lastDynamicTickMs = now;

      const proposed = overlay.getVisibleDiffRange(0.98);
      if (!proposed) return;

      const nextAbs = Math.abs(proposed[1]);
      const prevAbs = dynamicDiffRange ? Math.abs(dynamicDiffRange[1]) : 0;
      if (prevAbs > 0 && Math.abs(nextAbs - prevAbs) / prevAbs < 0.08) {
        return;
      }

      dynamicDiffRange = proposed;
      applyState(metadata, overlay, currentControls, dynamicDiffRange);
    });
  });
}

function applyState(
  metadata: Metadata,
  overlay: TileOverlayRenderer,
  controlState: ControlState,
  dynamicDiffRange: [number, number] | null,
): void {
  const overlayState = toOverlayState(metadata, controlState, dynamicDiffRange);
  overlay.updateState(overlayState);
  updateLegend(
    controlState.mode,
    overlayState.valueMin,
    overlayState.valueMax,
    controlState.variable,
  );
}

function toOverlayState(
  metadata: Metadata,
  controlState: ControlState,
  dynamicDiffRange: [number, number] | null,
): TileOverlayState {
  const metaA = metadata.scenarios[controlState.scenarioA].variables[controlState.variable];
  const metaB = metadata.scenarios[controlState.scenarioB].variables[controlState.variable];
  const [staticMin, staticMax] = getDisplayRange(
    controlState.mode,
    metaA.min,
    metaA.max,
    metaB.min,
    metaB.max,
  );
  const [valueMin, valueMax] = (
    controlState.mode === 'diff'
    && controlState.autoDiffScale
    && dynamicDiffRange
  )
    ? dynamicDiffRange
    : [staticMin, staticMax];

  return {
    scenarioA: controlState.scenarioA,
    scenarioB: controlState.scenarioB,
    variable: controlState.variable,
    mode: controlState.mode,
    valueMin,
    valueMax,
    opacity: controlState.opacity,
  };
}

function getDisplayRange(
  mode: DisplayMode,
  minA: number,
  maxA: number,
  minB: number,
  maxB: number,
): [number, number] {
  if (mode === 'diff') {
    const maxAbs = Math.max(Math.abs(maxB - minA), Math.abs(maxA - minB), 1);
    return [-maxAbs, maxAbs];
  }
  if (mode === 'b') {
    return [minB, maxB];
  }
  return [minA, maxA];
}

void main();
