import type { Metadata, DisplayMode } from '../data/types';

export interface ControlState {
  scenarioA: string;
  scenarioB: string;
  mode: DisplayMode;
  variable: string;
  opacity: number;
}

export type OnChangeCallback = (state: ControlState) => void;

export function initControls(metadata: Metadata, onChange: OnChangeCallback): ControlState {
  const scenarioNames = Object.keys(metadata.scenarios);
  const selectA = document.getElementById('scenario-a') as HTMLSelectElement;
  const selectB = document.getElementById('scenario-b') as HTMLSelectElement;
  const modeSelect = document.getElementById('display-mode') as HTMLSelectElement;
  const varSelect = document.getElementById('variable') as HTMLSelectElement;
  const opacitySlider = document.getElementById('opacity') as HTMLInputElement;

  // Populate scenario dropdowns
  for (const name of scenarioNames) {
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    selectA.add(new Option(label, name));
    selectB.add(new Option(label, name));
  }

  // Default: existing vs alt1
  selectA.value = scenarioNames[0];
  selectB.value = scenarioNames.length > 1 ? scenarioNames[1] : scenarioNames[0];

  const state: ControlState = {
    scenarioA: selectA.value,
    scenarioB: selectB.value,
    mode: modeSelect.value as DisplayMode,
    variable: varSelect.value,
    opacity: parseInt(opacitySlider.value) / 100,
  };

  const emit = () => {
    state.scenarioA = selectA.value;
    state.scenarioB = selectB.value;
    state.mode = modeSelect.value as DisplayMode;
    state.variable = varSelect.value;
    state.opacity = parseInt(opacitySlider.value) / 100;
    onChange(state);
  };

  selectA.addEventListener('change', emit);
  selectB.addEventListener('change', emit);
  modeSelect.addEventListener('change', emit);
  varSelect.addEventListener('change', emit);
  opacitySlider.addEventListener('input', emit);

  return state;
}
