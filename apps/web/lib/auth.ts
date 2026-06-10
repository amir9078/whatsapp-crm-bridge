// Client-side session token (M7). Kept in localStorage for the separate-origin dev setup
// (web :3000 → API :4000); M8 hardening can move this behind a same-origin proxy + HttpOnly
// cookie per docs/04 §2.1.
const KEY = 'wcb_token';

export const getToken = (): string | null =>
  typeof window === 'undefined' ? null : window.localStorage.getItem(KEY);

export const setToken = (token: string): void => window.localStorage.setItem(KEY, token);

export const clearToken = (): void => window.localStorage.removeItem(KEY);
