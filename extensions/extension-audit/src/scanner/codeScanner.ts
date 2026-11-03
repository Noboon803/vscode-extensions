import { parse, type Options } from 'acorn';
import type { Finding, RuleId } from './types';

/** 対象のコードは信頼できないので、構文解析するだけで絶対に実行しない */

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface SourceScanResult {
  findings: Finding[];
  /** 構文解析に失敗した場合のメッセージ。テキストとして調べた結果だけが findings に入る */
  parseError?: string;
}

const MAX_LOCATIONS = 5;
const MIN_HEX_IDENTIFIERS = 50;
const MIN_CHAR_CODE_ARGS = 20;
const MIN_ENTROPY_LENGTH = 512;
const MIN_ENTROPY = 3.9;
const EXCERPT_BEFORE = 30;
const EXCERPT_AFTER = 70;
/** デコードと動的実行を一連の処理とみなす距離（文字数）。バンドル内の無関係な処理を除くため */
const MAX_DECODE_DYNAMIC_DISTANCE = 512;

const NETWORK_MODULES = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'undici',
  'ws',
  'axios',
  'node-fetch',
  'got',
]);
/** 名前を組み立てて読み込まれていたら検出を避けていると判断するモジュール */
const SENSITIVE_MODULES = new Set(['child_process', 'vm', 'fs', 'os', ...NETWORK_MODULES]);
const NETWORK_CONSTRUCTORS = new Set(['WebSocket', 'XMLHttpRequest', 'EventSource']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
const ENV_ENUMERATORS = new Set(['keys', 'values', 'entries', 'assign']);
/** グローバルオブジェクトを取得するだけの定型句。多くのライブラリに含まれ、任意のコードは実行しない */
const GLOBAL_GETTER = /^\s*(?:return\s+this|this|\(function\s*\(\)\s*\{\s*return\s+this;?\s*\}\)\(\))\s*;?\s*$/;
/** バンドラーが child_process に付ける変数名（child_process_1、_child_process、child_process__rspack_import_0 など） */
const CHILD_PROCESS_IDENTIFIER = /^_?child_process(?:_|$)/;

const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>\\)]+/gi;
/** 仕様の名前空間やドキュメント用で、接続先の手がかりにならないホスト */
const IGNORED_HOST = /^(?:www\.w3\.org|schemas\..+|json-schema\.org|example\.(?:com|org|net)|www\.example\.(?:com|org|net))$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  [/(?:^|[\\/])\.ssh(?:[\\/]|$)/, '.ssh'],
  [/(?:^|[\\/])id_(?:rsa|ed25519|ecdsa|dsa)$/, 'SSH 秘密鍵'],
  [/(?:^|[\\/])\.aws(?:[\\/]|$)/, '.aws'],
  [/(?:^|[\\/])\.azure(?:[\\/]|$)/, '.azure'],
  [/(?:^|[\\/])\.kube(?:[\\/]|$)/, '.kube'],
  [/(?:^|[\\/])\.gnupg(?:[\\/]|$)/, '.gnupg'],
  [/(?:^|[\\/])\.npmrc$/, '.npmrc'],
  [/(?:^|[\\/])\.netrc$/, '.netrc'],
  [/(?:^|[\\/])\.git-credentials$/, '.git-credentials'],
  [/(?:^|[\\/])\.docker[\\/]config\.json$/, '.docker/config.json'],
  [/(?:^|[\\/])\.config[\\/]gcloud(?:[\\/]|$)/, '.config/gcloud'],
  [/(?:^|[\\/])\.config[\\/]gh(?:[\\/]|$)/, '.config/gh'],
  [/Library[\\/]Keychains/, 'macOS キーチェーン'],
  [/(?:^|[\\/])Login Data$/, 'ブラウザのパスワード保存先'],
];

const PERSISTENCE_PATTERNS: [RegExp, string][] = [
  [/(?:^|[\\/])\.(?:zshrc|zprofile|bashrc|bash_profile|profile)$/, 'シェルの設定ファイル'],
  [/Library[\\/]LaunchAgents/, 'LaunchAgents'],
  [/Library[\\/]LaunchDaemons/, 'LaunchDaemons'],
  [/(?:^|[\\/])\.config[\\/]autostart/, '.config/autostart'],
  [/CurrentVersion[\\/]+Run\b/, 'Windows の自動実行レジストリ'],
];

/**
 * 異体字セレクタとタグ文字。実際に VS Code 拡張機能でコードの隠蔽に使われた例がある。
 * 絵文字の FE0F は単独で現れるので、連続している場合だけ検出する
 */
const INVISIBLE_RUN = /[︀-️\u{E0100}-\u{E01EF}\u{E0000}-\u{E007F}]{16,}/gu;
const INVISIBLE_ANY = /[\u0000-\u001F\u007F︀-️\u{E0100}-\u{E01EF}\u{E0000}-\u{E007F}]+/gu;

class Collector {
  private readonly findings = new Map<string, Finding>();
  private lineStarts?: number[];
  private readonly offsets = new Map<RuleId, number[]>();

  constructor(
    private readonly source: string,
    private readonly file: string,
  ) {}

  add(rule: RuleId, detail: string, offset: number): void {
    const key = `${rule}\u0000${detail}`;
    let finding = this.findings.get(key);
    if (!finding) {
      finding = { rule, detail, file: this.file, count: 0, locations: [], excerpt: this.excerpt(offset) };
      this.findings.set(key, finding);
    }
    finding.count += 1;
    let offsets = this.offsets.get(rule);
    if (!offsets) {
      offsets = [];
      this.offsets.set(rule, offsets);
    }
    offsets.push(offset);
    if (finding.locations.length < MAX_LOCATIONS) {
      finding.locations.push(this.locate(offset));
    }
  }

  has(rule: RuleId): boolean {
    return this.firstOf(rule) !== undefined;
  }

  /** 2 つのルールの検出が近い位置にあるか */
  areNear(a: RuleId, b: RuleId, maxDistance: number): boolean {
    const second = [...(this.offsets.get(b) ?? [])].sort((x, y) => x - y);
    if (second.length === 0) {
      return false;
    }
    return (this.offsets.get(a) ?? []).some((offset) => {
      let low = 0;
      let high = second.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (second[middle] < offset) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      const nearest = [second[low], second[low - 1]].filter((value) => value !== undefined);
      return nearest.some((value) => Math.abs(value - offset) <= maxDistance);
    });
  }

  /** 組み合わせの判定に使う。ルールの最初の検出 */
  firstOf(rule: RuleId): Finding | undefined {
    for (const finding of this.findings.values()) {
      if (finding.rule === rule) {
        return finding;
      }
    }
    return undefined;
  }

  addCombination(rule: RuleId, basis: Finding): void {
    this.findings.set(`${rule}\u0000`, { ...basis, rule, detail: '', count: 1, locations: basis.locations.slice(0, 1) });
  }

  list(): Finding[] {
    return [...this.findings.values()];
  }

  private excerpt(offset: number): string {
    return this.source
      .slice(Math.max(0, offset - EXCERPT_BEFORE), offset + EXCERPT_AFTER)
      .replace(INVISIBLE_ANY, ' ')
      .trim();
  }

  private locate(offset: number): { line: number; column: number } {
    if (!this.lineStarts) {
      this.lineStarts = [0];
      for (let index = this.source.indexOf('\n'); index !== -1; index = this.source.indexOf('\n', index + 1)) {
        this.lineStarts.push(index + 1);
      }
    }
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - this.lineStarts[low] };
  }
}

function parseSource(source: string, file: string): AstNode {
  const base: Options = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
  };
  const order: ('script' | 'module')[] = file.endsWith('.mjs') ? ['module', 'script'] : ['script', 'module'];
  try {
    return parse(source, { ...base, sourceType: order[0] }) as unknown as AstNode;
  } catch {
    return parse(source, { ...base, sourceType: order[1] }) as unknown as AstNode;
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** 文字列の連結など、実行しなくても値が分かる式だけを評価する */
function staticString(node: unknown): string | undefined {
  if (!isNode(node)) {
    return undefined;
  }
  // 連結の左側が深くなるので、再帰せずに展開する
  const pending: unknown[] = [node];
  const parts: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isNode(current)) {
      return undefined;
    }
    if (current.type === 'Literal') {
      if (typeof current.value !== 'string') {
        return undefined;
      }
      parts.push(current.value);
    } else if (current.type === 'BinaryExpression' && current.operator === '+') {
      pending.push(current.right, current.left);
    } else if (current.type === 'TemplateLiteral') {
      const quasis = current.quasis as AstNode[];
      const expressions = current.expressions as AstNode[];
      for (let index = quasis.length - 1; index >= 0; index--) {
        const cooked = (quasis[index].value as { cooked?: string | null }).cooked;
        if (typeof cooked !== 'string') {
          return undefined;
        }
        pending.push({ type: 'Literal', start: 0, end: 0, value: cooked });
        if (index > 0) {
          pending.push(expressions[index - 1]);
        }
      }
    } else {
      return undefined;
    }
  }
  return parts.join('');
}

function isPlainLiteralOrTemplate(node: AstNode): boolean {
  return node.type === 'Literal' || (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0);
}

/** (0, eval)(x) のようなカンマ式を外す */
function unwrapSequence(node: AstNode): AstNode {
  let current = node;
  while (current.type === 'SequenceExpression') {
    const expressions = current.expressions as AstNode[];
    current = expressions[expressions.length - 1];
  }
  return current;
}

/** メンバーの名前を返す。a.b と a['b'] と a['' + 'b'] を区別しない */
function memberName(node: AstNode): { name: string; assembled: boolean } | undefined {
  const property = node.property as AstNode;
  if (!node.computed) {
    return property.type === 'Identifier' ? { name: property.name as string, assembled: false } : undefined;
  }
  const name = staticString(property);
  return name === undefined ? undefined : { name, assembled: !isPlainLiteralOrTemplate(property) };
}

function isIdentifier(node: unknown, name: string): boolean {
  return isNode(node) && node.type === 'Identifier' && node.name === name;
}

function isProcessEnv(node: unknown): boolean {
  return (
    isNode(node) &&
    node.type === 'MemberExpression' &&
    isIdentifier(node.object, 'process') &&
    memberName(node)?.name === 'env'
  );
}

function isGlobalGetter(args: AstNode[]): boolean {
  if (args.length !== 1) {
    return false;
  }
  const code = staticString(args[0]);
  return code !== undefined && GLOBAL_GETTER.test(code);
}

/** process.env そのものか、{ env: process.env } や { ...process.env } */
function containsProcessEnv(node: unknown): boolean {
  if (isProcessEnv(node)) {
    return true;
  }
  if (!isNode(node) || node.type !== 'ObjectExpression') {
    return false;
  }
  return (node.properties as AstNode[]).some((property) =>
    isProcessEnv(property.type === 'SpreadElement' ? property.argument : property.value),
  );
}

function isGlobalObject(node: unknown): boolean {
  return isNode(node) && node.type === 'Identifier' && GLOBAL_OBJECTS.has(node.name as string);
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isPublicIpv4(host: string): boolean {
  const match = IPV4.exec(host);
  if (!match) {
    return false;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  const isPrivate =
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  return !isPrivate;
}

function scanString(value: string, offset: number, collector: Collector): void {
  for (const match of value.matchAll(URL_PATTERN)) {
    let host: string;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host.includes('.') || IGNORED_HOST.test(host)) {
      continue;
    }
    collector.add('url', host, offset);
    if (isPublicIpv4(host)) {
      collector.add('ip-url', host, offset);
    }
  }
  // パスとして短いものだけを見る。文章内の言及は誤検出になりやすい
  if (value.length <= 256 && (!/\s/.test(value) || value.endsWith('Login Data'))) {
    for (const [pattern, label] of CREDENTIAL_PATTERNS) {
      if (pattern.test(value)) {
        collector.add('credential-path', label, offset);
      }
    }
    for (const [pattern, label] of PERSISTENCE_PATTERNS) {
      if (pattern.test(value)) {
        collector.add('persistence-path', label, offset);
      }
    }
  }
  if (
    value.length >= MIN_ENTROPY_LENGTH &&
    !/\s/.test(value) &&
    !value.startsWith('data:') &&
    shannonEntropy(value.slice(0, 4096)) >= MIN_ENTROPY
  ) {
    collector.add('high-entropy', '', offset);
  }
}

function normalizeModule(name: string): string {
  return name.startsWith('node:') ? name.slice('node:'.length) : name;
}

function recordModule(name: string, offset: number, assembled: boolean, collector: Collector): void {
  const moduleName = normalizeModule(name);
  if (moduleName === 'child_process') {
    collector.add('process-exec', moduleName, offset);
  } else if (moduleName === 'vm') {
    collector.add('dynamic-code', moduleName, offset);
  } else if (NETWORK_MODULES.has(moduleName)) {
    collector.add('network', moduleName, offset);
  }
  if (assembled && SENSITIVE_MODULES.has(moduleName)) {
    collector.add('hidden-module', moduleName, offset);
  }
}

function visitModuleArgument(argument: AstNode | undefined, collector: Collector, consumed: WeakSet<object>): void {
  if (!argument) {
    return;
  }
  const name = staticString(argument);
  if (name === undefined) {
    collector.add('dynamic-import', '', argument.start);
    return;
  }
  consumed.add(argument);
  recordModule(name, argument.start, !isPlainLiteralOrTemplate(argument), collector);
}

function visitCall(node: AstNode, collector: Collector, consumed: WeakSet<object>): void {
  const callee = unwrapSequence(node.callee as AstNode);
  const args = node.arguments as AstNode[];

  if (callee.type === 'Identifier') {
    const name = callee.name as string;
    if (name === 'require' || name === '__non_webpack_require__') {
      visitModuleArgument(args[0], collector, consumed);
    } else if (name === 'eval') {
      if (isGlobalGetter(args)) {
        consumed.add(callee);
      }
    } else if (name === 'Function') {
      if (!isGlobalGetter(args)) {
        collector.add('dynamic-code', 'Function', node.start);
      }
    } else if (name === 'fetch') {
      collector.add('network', 'fetch', node.start);
    } else if (name === 'atob') {
      collector.add('decode', 'atob', node.start);
    }
    return;
  }
  if (callee.type !== 'MemberExpression') {
    return;
  }
  const member = memberName(callee);
  if (!member) {
    return;
  }

  if (member.name === 'require') {
    visitModuleArgument(args[0], collector, consumed);
  } else if (isGlobalObject(callee.object) && (member.name === 'eval' || member.name === 'Function')) {
    collector.add('dynamic-code', member.name, node.start);
    if (member.assembled) {
      collector.add('hidden-module', member.name, node.start);
    }
  } else if (isGlobalObject(callee.object) && member.name === 'fetch') {
    collector.add('network', 'fetch', node.start);
  } else if (member.name === 'from' && isIdentifier(callee.object, 'Buffer')) {
    const encoding = staticString(args[1]);
    if (encoding === 'base64' || encoding === 'base64url' || encoding === 'hex') {
      collector.add('decode', encoding, node.start);
    }
  } else if (member.name === 'fromCharCode' && isIdentifier(callee.object, 'String')) {
    if (args.length >= MIN_CHAR_CODE_ARGS) {
      collector.add('char-code', '', node.start);
    }
  } else if (member.name === 'stringify' && isIdentifier(callee.object, 'JSON') && containsProcessEnv(args[0])) {
    collector.add('env-dump', 'JSON.stringify', node.start);
  } else if (ENV_ENUMERATORS.has(member.name) && isIdentifier(callee.object, 'Object')) {
    // Object.assign は process.env を「読む」側（2 番目以降の引数）だけを対象にする
    const candidates = member.name === 'assign' ? args.slice(1) : args.slice(0, 1);
    if (candidates.some(isProcessEnv)) {
      collector.add('env-enumerate', `Object.${member.name}`, node.start);
    }
  } else if (
    member.name === 'getSession' &&
    isNode(callee.object) &&
    callee.object.type === 'MemberExpression' &&
    memberName(callee.object)?.name === 'authentication'
  ) {
    collector.add('auth-session', '', node.start);
  }
}

function visitNew(node: AstNode, collector: Collector): void {
  const callee = unwrapSequence(node.callee as AstNode);
  let name: string | undefined;
  if (callee.type === 'Identifier') {
    name = callee.name as string;
  } else if (callee.type === 'MemberExpression' && isGlobalObject(callee.object)) {
    name = memberName(callee)?.name;
  }
  if (name === 'Function') {
    if (!isGlobalGetter(node.arguments as AstNode[])) {
      collector.add('dynamic-code', 'Function', node.start);
    }
  } else if (name && NETWORK_CONSTRUCTORS.has(name)) {
    collector.add('network', name, node.start);
  }
}

function pushChildren(node: AstNode, stack: AstNode[]): void {
  for (const key of Object.keys(node)) {
    // obj.eval や { eval: 1 } は eval の参照ではない
    if (
      (key === 'property' && node.type === 'MemberExpression' && !node.computed) ||
      (key === 'key' &&
        !node.computed &&
        (node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition'))
    ) {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          stack.push(item);
        }
      }
    } else if (isNode(value)) {
      stack.push(value);
    }
  }
}

function walk(root: AstNode, collector: Collector): void {
  const consumed = new WeakSet<object>();
  let hexIdentifiers = 0;
  let firstHexIdentifier = 0;
  // ミニファイされたコードは非常に深くなるので、再帰せずにスタックで辿る
  const stack: AstNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as AstNode;

    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (isNode(node.source)) {
          visitModuleArgument(node.source, collector, consumed);
        }
        break;
      case 'ImportExpression':
        visitModuleArgument(node.source as AstNode, collector, consumed);
        break;
      case 'CallExpression':
        visitCall(node, collector, consumed);
        break;
      case 'NewExpression':
        visitNew(node, collector);
        break;
      case 'Property':
        // get-intrinsic ライブラリの組み込み関数の一覧。呼び出しではない
        if (isNode(node.key) && node.key.value === '%eval%' && isNode(node.value)) {
          consumed.add(node.value);
        }
        break;
      case 'Identifier': {
        const name = node.name as string;
        if (name === 'eval') {
          if (!consumed.has(node)) {
            collector.add('dynamic-code', 'eval', node.start);
          }
        } else if (CHILD_PROCESS_IDENTIFIER.test(name)) {
          collector.add('process-exec', 'child_process', node.start);
        } else if (/^_0x[0-9a-f]{3,}$/i.test(name)) {
          if (hexIdentifiers === 0) {
            firstHexIdentifier = node.start;
          }
          hexIdentifiers += 1;
        }
        break;
      }
      case 'Literal':
        if (typeof node.value === 'string') {
          // require を別名にされても見つけられるよう、モジュール名そのものの文字列も調べる
          if (!consumed.has(node) && normalizeModule(node.value) === 'child_process') {
            collector.add('process-exec', 'child_process', node.start);
          }
          scanString(node.value, node.start, collector);
        }
        break;
      case 'TemplateElement': {
        const cooked = (node.value as { cooked?: string | null }).cooked;
        if (typeof cooked === 'string') {
          scanString(cooked, node.start, collector);
        }
        break;
      }
      default:
        break;
    }

    pushChildren(node, stack);
  }

  if (hexIdentifiers >= MIN_HEX_IDENTIFIERS) {
    collector.add('hex-identifiers', '', firstHexIdentifier);
  }
}

function addCombinations(collector: Collector): void {
  const network = collector.has('network');
  const credential = collector.firstOf('credential-path');
  if (credential && network) {
    collector.addCombination('combo-credential-network', credential);
  }
  const env = collector.firstOf('env-dump');
  if (env && network) {
    collector.addCombination('combo-env-network', env);
  }
  const dynamicCode = collector.firstOf('dynamic-code');
  if (dynamicCode && collector.areNear('decode', 'dynamic-code', MAX_DECODE_DYNAMIC_DISTANCE)) {
    collector.addCombination('combo-decode-dynamic', dynamicCode);
  }
  const obfuscated = collector.firstOf('hex-identifiers') ?? collector.firstOf('char-code');
  if (obfuscated && (dynamicCode || collector.has('process-exec'))) {
    collector.addCombination('combo-obfuscated-exec', obfuscated);
  }
}

/** コード 1 ファイルを検査する。source は文字列として扱うだけで実行しない */
export function scanSource(source: string, file: string): SourceScanResult {
  const collector = new Collector(source, file);

  // 構文解析に失敗するファイルでも調べられるよう、テキストとして確認する
  for (const match of source.matchAll(INVISIBLE_RUN)) {
    collector.add('invisible-chars', '', match.index);
  }

  let parseError: string | undefined;
  try {
    walk(parseSource(source, file), collector);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  addCombinations(collector);
  return { findings: collector.list(), parseError };
}
