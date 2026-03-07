import type { Metadata, DisplayMode, MetricKind } from '../data/types';

export interface ControlState {
  scenarioA: string;
  scenarioB: string;
  mode: DisplayMode;
  variable: string;
  metric: MetricKind;
  threshold: number;
  opacity: number;
}

export type OnChangeCallback = (state: ControlState) => void;

export function initControls(metadata: Metadata, onChange: OnChangeCallback): ControlState {
  const scenarioNames = Object.keys(metadata.scenarios);
  const variableNames = metadata.variables;
  const metricNames = metadata.metrics;

  const selectA = document.getElementById('scenario-a') as HTMLSelectElement;
  const selectB = document.getElementById('scenario-b') as HTMLSelectElement;
  const modeSelect = document.getElementById('display-mode') as HTMLSelectElement;
  const varSelect = document.getElementById('variable') as HTMLSelectElement;
  const metricSelect = document.getElementById('metric') as HTMLSelectElement;
  const thresholdInput = document.getElementById('threshold') as HTMLInputElement;
  const opacitySlider = document.getElementById('opacity') as HTMLInputElement;

  selectA.innerHTML = '';
  selectB.innerHTML = '';
  varSelect.innerHTML = '';
  metricSelect.innerHTML = '';

  for (const name of scenarioNames) {
    selectA.add(new Option(name, name));
    selectB.add(new Option(name, name));
  }

  for (const variable of variableNames) {
    const label = variable.replaceAll('_', ' ');
    varSelect.add(new Option(label, variable));
  }

  for (const metric of metricNames) {
    metricSelect.add(new Option(metric.replaceAll('_', ' '), metric));
  }

  selectA.value = scenarioNames[0];
  selectB.value = scenarioNames.length > 1 ? scenarioNames[1] : scenarioNames[0];
  varSelect.value = variableNames[0];
  metricSelect.value = metricNames[0];
  thresholdInput.value = String(metadata.temporal.threshold_default ?? 0.5);

  const state: ControlState = {
    scenarioA: selectA.value,
    scenarioB: selectB.value,
    mode: modeSelect.value as DisplayMode,
    variable: varSelect.value,
    metric: metricSelect.value as MetricKind,
    threshold: parseFloat(thresholdInput.value),
    opacity: parseInt(opacitySlider.value, 10) / 100,
  };

  const emit = () => {
    state.scenarioA = selectA.value;
    state.scenarioB = selectB.value;
    state.mode = modeSelect.value as DisplayMode;
    state.variable = varSelect.value;
    state.metric = metricSelect.value as MetricKind;
    state.threshold = Number.isFinite(parseFloat(thresholdInput.value))
      ? parseFloat(thresholdInput.value)
      : 0.0;
    state.opacity = parseInt(opacitySlider.value, 10) / 100;
    onChange(state);
  };

  selectA.addEventListener('change', emit);
  selectB.addEventListener('change', emit);
  modeSelect.addEventListener('change', emit);
  varSelect.addEventListener('change', emit);
  metricSelect.addEventListener('change', emit);
  thresholdInput.addEventListener('input', emit);
  opacitySlider.addEventListener('input', emit);

  return state;
}
