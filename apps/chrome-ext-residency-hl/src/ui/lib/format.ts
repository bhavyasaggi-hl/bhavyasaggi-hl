/** Display formatters shared by every surface. */

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return '—';
  }
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'B'}`;
}

export function formatTime(epochMs: number | undefined): string {
  if (epochMs === undefined || epochMs <= 0) {
    return '—';
  }
  return new Date(epochMs).toLocaleTimeString();
}

/** Shared pass-rate colouring so headline figures cannot disagree with the list. */
export function rateTone(rate: number | null): string {
  if (rate === null) {
    return 'text-ink-muted';
  }
  return rate >= 0.999 ? 'text-pass' : 'text-fail';
}
