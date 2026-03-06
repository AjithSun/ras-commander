import type { Metadata, DisplayMode } from '../data/types';

export interface ControlState {
  scenarioA: string;
  scenarioB: string;
  mode: DisplayMode;
  variable: string;
  opacity: number;
  autoDiffScale: boolean;
}

export type OnChangeCallback = (state: ControlState) => void;

export function initControls(metadata: Metadata, onChange: OnChangeCallback): ControlState {
  const scenarioNames = Object.keys(metadata.scenarios);
  const variableNames = metadata.variables;
  const selectA = document.getElementById('scenario-a') as HTMLSelectElement;
  const selectB = document.getElementById('scenario-b') as HTMLSelectElement;
  const modeSelect = document.getElementById('display-mode') as HTMLSelectElement;
  const varSelect = document.getElementById('variable') as HTMLSelectElement;
  const opacitySlider = document.getElementById('opacity') as HTMLInputElement;
  const autoDiffScale = document.getElementById('auto-diff-scale') as HTMLInputElement;

  selectA.innerHTML = '';
  selectB.innerHTML = '';
  varSelect.innerHTML = '';

  // Populate scenario dropdowns
  for (const name of scenarioNames) {
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    selectA.add(new Option(label, name));
    selectB.add(new Option(label, name));
  }

  for (const variable of variableNames) {
    const label = variable
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    varSelect.add(new Option(label, variable));
  }

  selectA.value = scenarioNames[0];
  selectB.value = scenarioNames.length > 1 ? scenarioNames[1] : scenarioNames[0];
  varSelect.value = variableNames[0];

  const state: ControlState = {
    scenarioA: selectA.value,
    scenarioB: selectB.value,
    mode: modeSelect.value as DisplayMode,
    variable: varSelect.value,
    opacity: parseInt(opacitySlider.value) / 100,
    autoDiffScale: autoDiffScale.checked,
  };

  const emit = () => {
    state.scenarioA = selectA.value;
    state.scenarioB = selectB.value;
    state.mode = modeSelect.value as DisplayMode;
    state.variable = varSelect.value;
    state.opacity = parseInt(opacitySlider.value) / 100;
    state.autoDiffScale = autoDiffScale.checked;
    onChange(state);
  };

  selectA.addEventListener('change', emit);
  selectB.addEventListener('change', emit);
  modeSelect.addEventListener('change', emit);
  varSelect.addEventListener('change', emit);
  opacitySlider.addEventListener('input', emit);
  autoDiffScale.addEventListener('change', emit);

  return state;
}
