/** 設定のキーと、プレビュー内の要素の対応 */
const SELECTORS: Record<string, string> = {
  document: '#content',
  h1: '#content h1',
  h2: '#content h2',
  h3: '#content h3',
  h4: '#content h4',
  h5: '#content h5',
  h6: '#content h6',
  paragraph: '#content p',
  list: '#content ul, #content ol',
  listItem: '#content li',
  blockquote: '#content blockquote',
  inlineCode: '#content :not(pre) > code',
  codeBlock: '#content pre',
  table: '#content table',
  tableHeader: '#content th',
  tableCell: '#content td',
  hr: '#content hr',
  link: '#content a',
  bold: '#content strong',
  italic: '#content em',
};

/**
 * 指定できるプロパティ。設定はワークスペースからも与えられるので、
 * 外部のリソースを読み込める background-image などは許可しない
 */
const PROPERTIES: Record<string, { css: string; numberUnit?: string }> = {
  color: { css: 'color' },
  backgroundColor: { css: 'background-color' },
  fontFamily: { css: 'font-family' },
  fontSize: { css: 'font-size', numberUnit: 'px' },
  fontWeight: { css: 'font-weight' },
  fontStyle: { css: 'font-style' },
  lineHeight: { css: 'line-height' },
  letterSpacing: { css: 'letter-spacing', numberUnit: 'px' },
  textDecoration: { css: 'text-decoration' },
  marginTop: { css: 'margin-top', numberUnit: 'px' },
  marginBottom: { css: 'margin-bottom', numberUnit: 'px' },
  borderColor: { css: 'border-color' },
};

export interface StyleDeclaration {
  property: string;
  value: string;
  /** 無効な値を知らせるときの表示名（例: h1.color） */
  label: string;
}

export interface StyleRule {
  selector: string;
  declarations: StyleDeclaration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCssValue(value: unknown, numberUnit = ''): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}${numberUnit}`;
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 設定の値から CSS のルールを作る。知らない要素やプロパティは無視する */
export function buildStyleRules(config: unknown): StyleRule[] {
  if (!isRecord(config)) {
    return [];
  }
  const rules: StyleRule[] = [];
  for (const [element, properties] of Object.entries(config)) {
    const selector = Object.hasOwn(SELECTORS, element) ? SELECTORS[element] : undefined;
    if (!selector || !isRecord(properties)) {
      continue;
    }
    const declarations: StyleDeclaration[] = [];
    for (const [name, rawValue] of Object.entries(properties)) {
      const definition = Object.hasOwn(PROPERTIES, name) ? PROPERTIES[name] : undefined;
      const value = definition && toCssValue(rawValue, definition.numberUnit);
      if (definition && value) {
        declarations.push({ property: definition.css, value, label: `${element}.${name}` });
      }
    }
    if (declarations.length > 0) {
      rules.push({ selector, declarations });
    }
  }
  return rules;
}
