import type { CheatOption } from './cheatsheet';

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'dos']);

/** シェルで実行するコードか。language の省略時は bash として扱う */
export function isShellLanguage(language: string | undefined): boolean {
  return SHELL_LANGUAGES.has((language ?? 'bash').toLowerCase());
}

/** 記号を含む値を POSIX シェルの 1 つの引数として解釈されるようクォートする */
export function quoteShellValue(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * オプション 1 つの入力値。未操作は undefined で、既定値を使う。
 * text は行ごとの値の配列。単独の文字列は以前の保存形式で、空文字は省略を表す。
 * flag はチェックの状態。
 */
export type FieldValue = string | boolean | string[] | undefined;

/** text のオプションの入力行 */
export function optionRows(option: CheatOption, value: FieldValue): string[] {
  const current = value ?? option.default;
  if (Array.isArray(current)) {
    return current;
  }
  return current === undefined || current === '' ? [] : [String(current)];
}

/** 画面に並べる行。未入力でも 1 行は見せる */
export function visibleRows(option: CheatOption, value: FieldValue): string[] {
  const rows = optionRows(option, value);
  return rows.length === 0 ? [''] : rows;
}

export function withAddedRow(option: CheatOption, value: FieldValue): string[] {
  return [...visibleRows(option, value), ''];
}

export function withoutRow(option: CheatOption, value: FieldValue, row: number): string[] {
  return visibleRows(option, value).filter((_, index) => index !== row);
}

/**
 * 入力値をオプションの定義順にコードの末尾へ連結する。空の値は省略する。
 * 追加した順にしないのは、`docker run` のイメージのように引数の位置で意味が変わるため。
 */
export function composeCommand(code: string, options: CheatOption[], values: FieldValue[]): string {
  const parts: string[] = [];
  options.forEach((option, index) => {
    if (option.type === 'flag') {
      if ((values[index] ?? option.default) === true && option.flag) {
        parts.push(option.flag);
      }
      return;
    }
    for (const row of optionRows(option, values[index])) {
      const text = row.trim();
      if (text !== '') {
        const quoted = quoteShellValue(text);
        parts.push(option.flag ? `${option.flag}${option.separator ?? ' '}${quoted}` : quoted);
      }
    }
  });
  return [code.trimEnd(), ...parts].join(' ');
}

/** 保存する入力値。定義の順番が変わっても別のオプションへ入らないよう、名前で引けるようにする */
export interface CheatSettings {
  fields: Record<string, string | boolean | string[]>;
  techniques: TechniqueValues;
}

const fieldName = (option: CheatOption): string => option.flag ?? option.label;

export function snapshotFields(options: CheatOption[], values: FieldValue[]): CheatSettings['fields'] {
  const fields: CheatSettings['fields'] = {};
  options.forEach((option, index) => {
    const value = values[index];
    if (value !== undefined && value !== null) {
      fields[fieldName(option)] = value;
    }
  });
  return fields;
}

/** 保存になかったオプションは undefined にして、既定値を使わせる */
export function restoreFields(options: CheatOption[], fields: CheatSettings['fields']): FieldValue[] {
  return options.map((option) => fields[fieldName(option)]);
}

const POSIX_SHELLS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console']);

/** リダイレクトやパイプを POSIX の書き方で組み合わせられるか。language の省略時は bash として扱う */
export function supportsTechniques(language: string | undefined, code: string): boolean {
  return POSIX_SHELLS.has((language ?? 'bash').toLowerCase()) && !code.trimEnd().includes('\n');
}

export interface TechniqueChoice {
  id: string;
  label: string;
  /** コマンドに連結する文字列。`{}` は入力値に置き換える。省略すると何も連結しない */
  template?: string;
  /** 入力値が必要なときの入力欄の説明 */
  argLabel?: string;
  defaultArg?: string;
}

export interface TechniqueGroup {
  id: 'stdout' | 'stderr' | 'pipe';
  label: string;
  choices: TechniqueChoice[];
}

/** 選択肢の id は `stdout` のようなキーに、入力値は `stdoutArg` のようなキーに入れる */
export type TechniqueValues = Record<string, string | boolean | undefined>;

export const TECHNIQUE_GROUPS: TechniqueGroup[] = [
  {
    id: 'stdout',
    label: 'stdout',
    choices: [
      { id: 'keep', label: 'そのまま' },
      { id: 'discard', label: '捨てる', template: '> /dev/null' },
      { id: 'file', label: 'ファイルへ保存', template: '> {}', argLabel: 'ファイル名' },
      { id: 'append', label: 'ファイルへ追記', template: '>> {}', argLabel: 'ファイル名' },
    ],
  },
  {
    id: 'stderr',
    label: 'stderr',
    choices: [
      { id: 'keep', label: 'そのまま' },
      { id: 'discard', label: '捨てる', template: '2> /dev/null' },
      { id: 'merge', label: 'stdout へまとめる', template: '2>&1' },
      { id: 'file', label: 'ファイルへ保存', template: '2> {}', argLabel: 'ファイル名' },
    ],
  },
  {
    id: 'pipe',
    label: 'パイプ',
    choices: [
      { id: 'none', label: 'なし' },
      { id: 'grep', label: '絞り込み', template: '| grep {}', argLabel: '検索語' },
      { id: 'head', label: '先頭だけ', template: '| head -n {}', argLabel: '行数', defaultArg: '20' },
      { id: 'tail', label: '末尾だけ', template: '| tail -n {}', argLabel: '行数', defaultArg: '20' },
      { id: 'wc', label: '行数を数える', template: '| wc -l' },
      { id: 'less', label: 'ページャで見る', template: '| less' },
      { id: 'tee', label: '表示しつつ保存', template: '| tee {}', argLabel: 'ファイル名' },
    ],
  },
];

function techniqueFragment(group: TechniqueGroup, values: TechniqueValues): string | undefined {
  const choice = group.choices.find((c) => c.id === values[group.id]);
  if (!choice?.template) {
    return undefined;
  }
  if (!choice.argLabel) {
    return choice.template;
  }
  const argument = String(values[`${group.id}Arg`] ?? choice.defaultArg ?? '').trim();
  return argument === '' ? undefined : choice.template.replace('{}', () => quoteShellValue(argument));
}

/**
 * リダイレクトは順序で意味が変わるので、意図どおりに働く順で連結する。
 * パイプなしは `cmd > file 2>&1`（`2>&1 > file` だと stderr がファイルに入らない）。
 * パイプありは `cmd 2>&1 | grep x > file`（パイプの後ろの stderr 指定は cmd に効かない）。
 */
export function applyTechniques(
  command: string,
  values: TechniqueValues,
  groups: TechniqueGroup[] = TECHNIQUE_GROUPS,
): string {
  const fragment = (id: TechniqueGroup['id']) => {
    const group = groups.find((g) => g.id === id);
    return group && techniqueFragment(group, values);
  };
  const stdout = fragment('stdout');
  const stderr = fragment('stderr');
  const pipe = fragment('pipe');
  const parts = pipe ? [command, stderr, pipe, stdout] : [command, stdout, stderr];
  if (values.background === true) {
    parts.push('&');
  }
  return parts.filter(Boolean).join(' ');
}
