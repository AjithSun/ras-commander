import type { DisplayMode } from '../data/types';

const container = () => document.getElementById('legend')!;

export function updateLegend(mode: DisplayMode, vmin: number, vmax: number, variable: string) {
  const el = container();
  const isDiff = mode === 'diff';

  const prettyVar = variable.replaceAll('_', ' ');
  const title = isDiff
    ? 'Difference (B - A)'
    : `${prettyVar} (ft)`;

  let gradient: string;
  let labels: string;

  if (isDiff) {
    const range = Math.max(Math.abs(vmin), Math.abs(vmax));
    gradient = 'linear-gradient(to right, #1e63b0, #6fa4d4, #ffffff, #d44b4c, #d62728)';
    labels = `
      <span>-${range.toFixed(1)}</span>
      <span>0</span>
      <span>+${range.toFixed(1)}</span>
    `;
  } else {
    gradient = 'linear-gradient(to right, #edf5ff, #6badd7, #08306b)';
    labels = `
      <span>${vmin.toFixed(1)}</span>
      <span>${((vmin + vmax) / 2).toFixed(1)}</span>
      <span>${vmax.toFixed(1)}</span>
    `;
  }

  el.innerHTML = `
    <div class="legend-title">${title}</div>
    <div class="legend-bar" style="background: ${gradient}"></div>
    <div class="legend-labels">${labels}</div>
  `;
}
