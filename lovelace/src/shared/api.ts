export function apiUrl(host: string, path: string): string {
  const h = host.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${h}${p}`;
}

export function wsUrl(host: string): string {
  const h = host.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${h}/ws`;
}
