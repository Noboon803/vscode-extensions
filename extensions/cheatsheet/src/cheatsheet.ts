/** コマンドに連結する入力欄の定義 */
export interface CheatOption {
  /** `--author` など。省略すると値だけを連結する（位置引数） */
  flag?: string;
  /** 簡潔な説明。省略すると flag と同じ値になる */
  label: string;
  /** 必須のオプションか。説明の後ろに * を表示する */
  required?: boolean;
  /** text は入力欄、flag は値を取らないオプションのチェックボックス */
  type: 'text' | 'flag';
  placeholder?: string;
  default?: string | boolean;
  /** flag と値の間に置く文字。既定は半角スペース */
  separator?: string;
}

/** 1 件のチート */
export interface Cheat {
  /** お気に入りなどの識別に使う。YAML で省略するとタイトルと同じ値になる */
  id: string;
  title: string;
  description?: string;
  /** コマンドやコード。コードブロックとして表示する */
  code?: string;
  /** code の言語。構文ハイライトに使う。省略すると bash */
  language?: string;
  /** code の末尾に連結するオプション */
  options?: CheatOption[];
  /** 補足の解説 */
  notes?: string;
}

/** git や bash など、チートをまとめる上位階層 */
export interface Category {
  /** YAML のファイル名（拡張子なし） */
  id: string;
  name: string;
  cheats: Cheat[];
}
