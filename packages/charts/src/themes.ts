import type { ChartTheme } from './types';
export const darkTheme: Readonly<ChartTheme> = Object.freeze({
  background: '#10151d',
  text: '#dce4ee',
  mutedText: '#8290a4',
  grid: '#202a37',
  border: '#344052',
  crosshair: '#9bacc1',
  up: '#45d6ad',
  down: '#f47786',
  accent: '#80b5ff',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 11,
});
export const lightTheme: Readonly<ChartTheme> = Object.freeze({
  background: '#fbfcfe',
  text: '#243347',
  mutedText: '#68798e',
  grid: '#e7ecf2',
  border: '#c9d3df',
  crosshair: '#697d95',
  up: '#087e65',
  down: '#ce435e',
  accent: '#2866bb',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 11,
});
