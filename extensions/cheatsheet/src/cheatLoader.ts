import { parse } from 'yaml';
import * as vscode from 'vscode';
import type { Category, Cheat, CheatOption } from './cheatsheet';
import { TECHNIQUE_GROUPS, type TechniqueChoice, type TechniqueGroup } from './command';

/** 組み合わせの選択肢を定義するファイル。カテゴリとしては扱わない */
const TECHNIQUES_FILE = /^_techniques\.ya?ml$/i;

export interface CheatContent {
  categories: Category[];
  techniqueGroups: TechniqueGroup[];
}

export interface LoadResult extends CheatContent {
  /** 読み込めなかったファイルや項目の説明。問題のない内容は読み込む */
  errors: string[];
}

const OPTIONAL_TEXT_FIELDS = ['id', 'description', 'code', 'notes', 'language'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): CheatOption | string {
  if (!isRecord(value)) {
    return 'マッピング形式ではありません';
  }
  for (const field of ['flag', 'label', 'separator']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      return `${field} が文字列ではありません`;
    }
  }
  // `placeholder: -7` のように書くと YAML では数値になるので、数値も受け付ける
  const { placeholder } = value;
  if (placeholder !== undefined && placeholder !== null && !['string', 'number'].includes(typeof placeholder)) {
    return 'placeholder の形式が正しくありません';
  }
  const flag = (value.flag as string | null | undefined) || undefined;
  const label = (value.label as string | null | undefined) || flag;
  if (!label) {
    return 'flag か label が必要です';
  }
  const type = value.type ?? 'text';
  if (type !== 'text' && type !== 'flag') {
    return 'type は text か flag です';
  }
  if (type === 'flag' && !flag) {
    return 'type が flag のときは flag が必要です';
  }
  if (value.required !== undefined && value.required !== null && typeof value.required !== 'boolean') {
    return 'required は true か false です';
  }
  const fallback = value.default;
  if (fallback !== undefined && fallback !== null && !['string', 'number', 'boolean'].includes(typeof fallback)) {
    return 'default の形式が正しくありません';
  }
  return {
    flag,
    label,
    required: value.required === true,
    type,
    placeholder: placeholder === undefined || placeholder === null || placeholder === '' ? undefined : String(placeholder),
    default: type === 'flag' ? fallback === true : fallback === undefined || fallback === null ? undefined : String(fallback),
    separator: (value.separator as string | null | undefined) ?? undefined,
  };
}

function parseCheat(value: unknown): { cheat?: Cheat; error?: string } {
  if (!isRecord(value)) {
    return { error: 'マッピング形式ではありません' };
  }
  if (typeof value.title !== 'string' || value.title === '') {
    return { error: 'title がありません' };
  }
  for (const field of OPTIONAL_TEXT_FIELDS) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      return { error: `${field} が文字列ではありません（${value.title}）` };
    }
  }
  let options: CheatOption[] | undefined;
  if (value.options !== undefined && value.options !== null) {
    if (!Array.isArray(value.options)) {
      return { error: `options が配列ではありません（${value.title}）` };
    }
    if (!value.code) {
      return { error: `options には code が必要です（${value.title}）` };
    }
    options = [];
    for (const [index, item] of value.options.entries()) {
      const parsed = parseOption(item);
      if (typeof parsed === 'string') {
        return { error: `options[${index}]: ${parsed}（${value.title}）` };
      }
      options.push(parsed);
    }
  }
  const text = (field: (typeof OPTIONAL_TEXT_FIELDS)[number]) => (value[field] as string | null | undefined) || undefined;
  return {
    cheat: {
      id: text('id') ?? value.title,
      title: value.title,
      description: text('description'),
      // ブロック記法の末尾の改行がコード表示で空行にならないようにする
      code: text('code')?.replace(/\n+$/, ''),
      language: text('language'),
      options,
      notes: text('notes'),
    },
  };
}

/** YAML 1 ファイルを解釈する。ファイルが空なら category は undefined になる */
export function parseCategory(id: string, source: string, label: string): { category?: Category; errors: string[] } {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return { errors: [`${label}: YAML の構文エラー: ${firstLine}`] };
  }
  if (document === null || document === undefined) {
    return { errors: [] };
  }
  if (!isRecord(document) || !Array.isArray(document.cheats)) {
    return { errors: [`${label}: 最上位に cheats の配列がありません`] };
  }
  if (document.name !== undefined && typeof document.name !== 'string') {
    return { errors: [`${label}: name が文字列ではありません`] };
  }

  const errors: string[] = [];
  const cheats: Cheat[] = [];
  document.cheats.forEach((value, index) => {
    const { cheat, error } = parseCheat(value);
    if (cheat) {
      cheats.push(cheat);
    } else {
      errors.push(`${label}: cheats[${index}]: ${error}`);
    }
  });
  return { category: { id, name: document.name || id, cheats }, errors };
}

function parseTechniqueChoice(value: unknown): TechniqueChoice | string {
  if (!isRecord(value)) {
    return 'マッピング形式ではありません';
  }
  for (const field of ['id', 'label', 'template', 'argLabel']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      return `${field} が文字列ではありません`;
    }
  }
  const { defaultArg } = value;
  if (defaultArg !== undefined && defaultArg !== null && !['string', 'number'].includes(typeof defaultArg)) {
    return 'defaultArg の形式が正しくありません';
  }
  const label = value.label as string | null | undefined;
  const template = value.template as string | null | undefined;
  if (!label || !template) {
    return 'label と template が必要です';
  }
  const takesArgument = template.includes('{}');
  if (value.argLabel && !takesArgument) {
    return 'argLabel を使うには template に {} が必要です';
  }
  return {
    id: (value.id as string | null | undefined) || label,
    label,
    template,
    argLabel: takesArgument ? (value.argLabel as string | null | undefined) || '値' : undefined,
    defaultArg: takesArgument && defaultArg !== undefined && defaultArg !== null ? String(defaultArg) : undefined,
  };
}

/** _techniques.yaml の選択肢を既存の項目へ足す。同じ id の選択肢は元の位置で置き換える */
export function mergeTechniqueFile(
  groups: TechniqueGroup[],
  source: string,
  label: string,
): { groups: TechniqueGroup[]; errors: string[] } {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return { groups, errors: [`${label}: YAML の構文エラー: ${firstLine}`] };
  }
  if (document === null || document === undefined) {
    return { groups, errors: [] };
  }
  if (!isRecord(document)) {
    return { groups, errors: [`${label}: 最上位は stdout / stderr / pipe のマッピングにしてください`] };
  }

  const errors: string[] = [];
  for (const key of Object.keys(document)) {
    if (!groups.some((group) => group.id === key)) {
      errors.push(`${label}: 不明な項目です: ${key}`);
    }
  }
  const merged = groups.map((group) => {
    const additions = document[group.id];
    if (additions === undefined || additions === null) {
      return group;
    }
    if (!Array.isArray(additions)) {
      errors.push(`${label}: ${group.id} が配列ではありません`);
      return group;
    }
    const choices = [...group.choices];
    additions.forEach((value, index) => {
      const parsed = parseTechniqueChoice(value);
      if (typeof parsed === 'string') {
        errors.push(`${label}: ${group.id}[${index}]: ${parsed}`);
        return;
      }
      const existing = choices.findIndex((choice) => choice.id === parsed.id);
      if (existing >= 0) {
        choices[existing] = parsed;
      } else {
        choices.push(parsed);
      }
    });
    return { ...group, choices };
  });
  return { groups: merged, errors };
}

/** 同じ ID のカテゴリをまとめる。後のものを優先し、同じ ID のチートは元の位置で置き換える */
export function mergeCategories(categories: Category[]): Category[] {
  const merged = new Map<string, { name: string; cheats: Map<string, Cheat> }>();
  for (const category of categories) {
    const target = merged.get(category.id) ?? { name: category.name, cheats: new Map<string, Cheat>() };
    target.name = category.name;
    for (const cheat of category.cheats) {
      target.cheats.set(cheat.id, cheat);
    }
    merged.set(category.id, target);
  }
  return [...merged]
    .map(([id, { name, cheats }]) => ({ id, name, cheats: [...cheats.values()] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** フォルダを順に読み込む。同じカテゴリやチートは後のフォルダの内容を優先する */
export async function loadContent(folders: vscode.Uri[]): Promise<LoadResult> {
  const categories: Category[] = [];
  let techniqueGroups = TECHNIQUE_GROUPS;
  const errors: string[] = [];
  for (const folder of folders) {
    let files: [string, vscode.FileType][];
    try {
      files = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      errors.push(`フォルダを読み込めません: ${folder.fsPath}`);
      continue;
    }
    const names = files
      .filter(([name, type]) => type !== vscode.FileType.Directory && /\.ya?ml$/i.test(name))
      .map(([name]) => name)
      .sort();
    for (const name of names) {
      const file = vscode.Uri.joinPath(folder, name);
      try {
        const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        if (TECHNIQUES_FILE.test(name)) {
          const merged = mergeTechniqueFile(techniqueGroups, source, file.fsPath);
          techniqueGroups = merged.groups;
          errors.push(...merged.errors);
          continue;
        }
        const result = parseCategory(name.replace(/\.ya?ml$/i, ''), source, file.fsPath);
        errors.push(...result.errors);
        if (result.category) {
          categories.push(result.category);
        }
      } catch {
        errors.push(`ファイルを読み込めません: ${file.fsPath}`);
      }
    }
  }
  return { categories: mergeCategories(categories), techniqueGroups, errors };
}

/** フォルダ内の YAML の変更を監視する。保存時に続けて届くイベントはまとめて 1 回にする */
export function watchContentFolder(folder: vscode.Uri, onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*.{yaml,yml}'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 200);
  };
  const subscriptions = [watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule)];
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    subscriptions.forEach((subscription) => subscription.dispose());
    watcher.dispose();
  });
}
