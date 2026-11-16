/** auto は VS Code のテーマに従う。light と dark は VS Code のテーマに関わらず固定する */
export type PreviewTheme = 'auto' | 'light' | 'dark';

const THEMES: readonly PreviewTheme[] = ['auto', 'light', 'dark'];

export function normalizeTheme(value: unknown): PreviewTheme {
  return THEMES.find((theme) => theme === value) ?? 'auto';
}

/** ヘッダーのボタンで切り替える順番 */
export function nextTheme(theme: PreviewTheme): PreviewTheme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}
