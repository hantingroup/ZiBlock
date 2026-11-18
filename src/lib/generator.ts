import * as Blockly from 'blockly';
import {
  conditionsForGroup,
  getCachedLexiconMeta,
  lex,
  lexiconQuery,
  LexiconQueryError,
  renderExpression,
  segment,
  type Condition,
  type LengthComparison,
  type LexiconMeta,
} from './lexicons';
import {
  conditionKind,
  findEnclosingLexicon,
  lexiconBlockName,
} from './lexicon-ui';
import { isFilterOp } from './transforms';

export const Symbols = {
  // Symbols
  Head: '[[',
  Tail: ']]',
  Modify: '@',
  Length: '=',
  Cache: '>',

  // Syntaxes
  LingerAssign: '>>>', // SYNtax LingerAssign
  LingerRef: '<<<',
  SliceSep: ':',
  Calculate: '=',
  InnerValAssign: '>>',
  InnerValRef: '<<',
  InnerValField: ':',
  Reference: '<', // 没有 SYN_ASSIGN，用的是 SYM_CACHE
  Font: ':',
  Immediate: '#',
  Repeat: '*',
  RepeatLazy: '**',

  StrictMode: '$$'
}

const Charsets = {
  Range: "-－～—",
  SegSep: ";；|/",
  SplitSep: "，、 ",
  Sep: "，、；？,.; \n",
  // Inline: "\ue104-\ue500",
}

// RCS_SEP = "\\s\\，\\、\\；\\？\\,\\;"  # 此处不用escape是因为\s会被escape转义失效
// RCG_ELLIPSIS = "\\.\\.\\.|\\.\\.\\.\\.\\.\\.|\\…|\\…\\…|\\。\\。\\。|\\-|\\~|\\－|\\～|\\—|\\*"

const phrasesToEscape = Object.values(Symbols);
phrasesToEscape.push('\\', ...Object.values(Charsets)
  .flatMap(chars => chars.split('')));

const casesToEscape = phrasesToEscape.map(RegExp.escape);
casesToEscape.push('\ue104-\ue500');

const escapeRegex = new RegExp('(' + casesToEscape.join('|') + ')', 'g');

function escape(text: string) {
  return text.replaceAll(escapeRegex, fullmatch =>
    Array.from(fullmatch).map(char => '\\' + char).join(''));
}

function translate(text: string | null) {
  return `${Symbols.Head}${text || ''}${Symbols.Tail}`;
}

// Blockly's ORDER_NONE: passing it to valueToCode suppresses parentheses.
const ORDER_NONE = 99

const Generator = new Blockly.Generator('tzlang')
export default Generator

const extractCode = (code: string | [string, number]) => {
  return Array.isArray(code) ? code[0] : code;
}

/** Trimmed value of a text/dropdown field. */
function fieldText(block: Blockly.Block, name: string): string {
  return String(block.getFieldValue(name) ?? '').trim()
}

/** Value-slot literals: their text must be escaped inside DSL contexts. */
const LITERAL_SLOT_TYPES = new Set([
  'literal_text',
  'literal_multiline',
  'literal_number',
])

/** Code of a value input (empty when nothing is connected). */
function slotCode(block: Blockly.Block, name: string): string {
  return Generator.valueToCode(block, name, ORDER_NONE) || ''
}

/** Trimmed code of a value input. */
function slotText(block: Blockly.Block, name: string): string {
  return slotCode(block, name).trim()
}

/** Optional numeric slots use their 0 default to mean "not filled in". */
function unsetZero(text: string): string {
  return text === '0' ? '' : text
}

/**
 * Text of a value slot for a DSL context. A literal shadow is plain text and
 * is escaped; a reporter is already an expression and is used as-is.
 */
function escapedSlotText(
  block: Blockly.Block,
  name: string,
  trim = true,
): string {
  const target = block.getInputTargetBlock(name)
  if (target && LITERAL_SLOT_TYPES.has(target.type)) {
    const text = String(target.getFieldValue('TEXT') ?? '')
    return escape(trim ? text.trim() : text)
  }
  return trim ? slotText(block, name) : slotCode(block, name)
}

/** Number read from a value slot, or undefined when it is not numeric. */
function slotNumber(
  block: Blockly.Block,
  name: string,
): number | undefined {
  const text = slotText(block, name)
  if (!text) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

// Top-level concatenation ====================================================
//
// Every general block is a string expression. The DSL concatenates top-level
// expressions directly, so the stock workspaceToCode (which joins top blocks
// with newlines) is replaced.

/** Statement chains concatenate: append the next block unless thisOnly. */
Generator.scrub_ = (
  block: Blockly.Block,
  code: string,
  thisOnly: boolean,
): string => {
  const usedAsValue = !!block.outputConnection?.targetConnection;
  const next = block.getNextBlock();
  if (!usedAsValue && !thisOnly && next) code += Generator.blockToCode(next);
  return code;
};

Generator.workspaceToCode = function (
  this: Blockly.Generator,
  workspace?: Blockly.Workspace,
): string {
  if (!workspace) throw new Error('No workspace supplied to workspaceToCode');
  this.init(workspace);
  const code = workspace
    .getTopBlocks(true)
    .map((block) => {
      const generated = this.blockToCode(block);
      return Array.isArray(generated) ? generated[0] : generated;
    })
    .filter(Boolean)
    .join('');
  return this.finish(code);
};

// Value slots ================================================================

Generator.forBlock['literal_text'] =
Generator.forBlock['literal_multiline'] =
Generator.forBlock['literal_number'] = (block: Blockly.Block): [string, number] => [
  String(block.getFieldValue('TEXT') ?? ''),
  ORDER_NONE,
]

// Text =======================================================================

Generator.forBlock['text_multiline'] =
Generator.forBlock['text'] = (block: Blockly.Block): [string, number] => [
  String(block.getFieldValue('TEXT') ?? ''),
  ORDER_NONE,
]

Generator.forBlock['translate_multiline'] =
Generator.forBlock['translate'] = (block: Blockly.Block): [string, number] => [
  translate(slotCode(block, 'TEXT')),
  ORDER_NONE,
]

Generator.forBlock['translate_block'] = (
  block: Blockly.Block,
): [string, number] => [
  translate(escapedSlotText(block, 'BODY', false)),
  ORDER_NONE,
]

Generator.forBlock['slice'] = (block: Blockly.Block): [string, number] => {
  const body = slotCode(block, 'BODY')
  const start = slotText(block, 'START')
  const stop = unsetZero(slotText(block, 'STOP'))
  const step = unsetZero(slotText(block, 'STEP'))
  if (!body) return ['', ORDER_NONE]
  if (!start && !stop && !step) return [body, ORDER_NONE]
  let code = `${body}:${start}`
  if (stop || step) code += `:${stop}`
  if (step) code += `:${step}`
  return [translate(code), ORDER_NONE]
}

Generator.forBlock['transform'] = (block: Blockly.Block): [string, number] => {
  const body = slotCode(block, 'BODY')
  const op = fieldText(block, 'OP')
  const cname = slotText(block, 'CNAME')
  if (!body || !op) return ['', ORDER_NONE]
  let code = `${body}:${op}`
  if (!isFilterOp(op)) {
    const charset = escapedSlotText(block, 'CHARSET', false)
    if (charset) code += `@${charset}`
  }
  if (cname) code += `>${cname}`
  return [translate(code), ORDER_NONE]
}

function aliasCode(block: Blockly.Block): string {
  const alias = fieldText(block, 'ALIAS')
  if (!alias) return ''
  return translate(alias)
}

Generator.forBlock['alias'] =
Generator.forBlock['alias_value'] = (block: Blockly.Block): [string, number] => [
  aliasCode(block),
  ORDER_NONE,
]


// Lexicon ====================================================================

/**
 * Lexicon context for a query condition. Condition statements sit inside a
 * lexicon block's 查询 input, so the enclosing lexicon supplies the schema used
 * for validation.
 */
function contextFor(block: Blockly.Block): {
  name: string;
  meta?: LexiconMeta;
} | undefined {
  const lexicon = findEnclosingLexicon(block);
  if (!lexicon) return undefined;
  const name = lexiconBlockName(lexicon);
  return { name, meta: name ? getCachedLexiconMeta(name) : undefined };
}

/** Renders one condition block as a DSL segment, validating against meta. */
function renderCondition(
  block: Blockly.Block,
  build: () => Condition,
): string {
  try {
    return lexiconQuery(segment(build()), contextFor(block)?.meta).build();
  } catch (error) {
    // Incomplete or invalid conditions simply contribute no segment.
    if (error instanceof LexiconQueryError) return '';
    throw error;
  }
}

// Query expression ===========================================================
//
// A query stack is an OR of ANDs: 或者 separators split OR branches, and the
// lines inside one branch are ANDed. 取反 negates the whole inner expression.
// De Morgan plus DNF distribution turns that into the flat &/| form the
// fill-in DSL accepts (it has no general grouping parentheses).

type QueryExpr =
  | {
      kind: 'leaf';
      code: string;
      negated: boolean;
      group?: string;
      condition?: Condition['kind'];
    }
  | { kind: 'and' | 'or'; items: QueryExpr[] };

type QueryLeaf = Extract<QueryExpr, { kind: 'leaf' }>;

const MAX_QUERY_CLAUSES = 512;
const MAX_QUERY_TERMS = 2048;

function collapse(
  kind: 'and' | 'or',
  items: (QueryExpr | undefined)[],
): QueryExpr | undefined {
  const present = items.filter((item): item is QueryExpr => !!item);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { kind, items: present };
}

/** De Morgan: swap AND/OR and flip the leaves. */
function negateExpr(expr: QueryExpr | undefined): QueryExpr | undefined {
  if (!expr) return undefined;
  if (expr.kind === 'leaf') return { ...expr, negated: !expr.negated };
  return collapse(
    expr.kind === 'and' ? 'or' : 'and',
    expr.items.map(negateExpr),
  );
}

/** Adds @组 to every condition leaf that the group can run. */
function applyGroup(
  expr: QueryExpr | undefined,
  group: string,
  meta: LexiconMeta | undefined,
): QueryExpr | undefined {
  if (!expr || !group) return expr;
  if (expr.kind === 'leaf') {
    // An inner group wins; validation warns about nested 组.
    if (expr.group) return expr;
    if (
      meta &&
      expr.condition &&
      !conditionsForGroup(meta, group).includes(expr.condition)
    )
      return expr;
    return { ...expr, group };
  }
  return {
    kind: expr.kind,
    items: expr.items
      .map((item) => applyGroup(item, group, meta))
      .filter((item): item is QueryExpr => !!item),
  };
}

/** One statement inside a wrapper or the query input. */
function statementExpr(block: Blockly.Block): QueryExpr | undefined {
  if (block.type === 'lexicon_not')
    return negateExpr(parseStack(block, 'ITEM'));
  if (block.type === 'lexicon_group') {
    const group = String(block.getFieldValue('GROUP') ?? '');
    return applyGroup(
      parseStack(block, 'ITEM'),
      group,
      contextFor(block)?.meta,
    );
  }
  const code = extractCode(Generator.blockToCode(block, true)).trim();
  if (!code) return undefined;
  return {
    kind: 'leaf',
    code,
    negated: false,
    condition: conditionKind(block),
  };
}

/** Reads a stack: 或者 splits OR branches; everything else is ANDed. */
function parseStack(
  block: Blockly.Block,
  input: string,
): QueryExpr | undefined {
  const branches: (QueryExpr | undefined)[] = [];
  let current: (QueryExpr | undefined)[] = [];
  const flush = () => {
    branches.push(collapse('and', current));
    current = [];
  };
  for (
    let child = block.getInputTargetBlock(input);
    child;
    child = child.getNextBlock()
  ) {
    if (child.type === 'lexicon_or') {
      flush();
      continue;
    }
    current.push(statementExpr(child));
  }
  flush();
  return collapse('or', branches);
}

/** OR of AND clauses; undefined when the expansion would get too large. */
function dnf(expr: QueryExpr): QueryLeaf[][] | undefined {
  if (expr.kind === 'leaf') return [[expr]];
  if (expr.kind === 'or') {
    const clauses: QueryLeaf[][] = [];
    for (const item of expr.items) {
      const part = dnf(item);
      if (!part) return undefined;
      clauses.push(...part);
      if (clauses.length > MAX_QUERY_CLAUSES) return undefined;
    }
    return clauses;
  }

  let clauses: QueryLeaf[][] = [[]];
  for (const item of expr.items) {
    const part = dnf(item);
    if (!part) return undefined;
    const next: QueryLeaf[][] = [];
    for (const left of clauses)
      for (const right of part) {
        const merged = [...left, ...right];
        if (merged.length > MAX_QUERY_TERMS) return undefined;
        next.push(merged);
        if (next.length > MAX_QUERY_CLAUSES) return undefined;
      }
    clauses = next;
  }
  return clauses;
}

/** `!` binds to one segment, and a group annotation stays outside it. */
function renderLeaf(leaf: QueryLeaf): string {
  return `${leaf.negated ? '!' : ''}${leaf.code}${leaf.group ? `@${leaf.group}` : ''}`;
}

function renderExpr(expr: QueryExpr | undefined): string {
  if (!expr) return '';
  const clauses = dnf(expr);
  if (!clauses) return '';
  return clauses
    .map((clause) => clause.map(renderLeaf).join('&'))
    .filter(Boolean)
    .join('|');
}

function queryCode(
  block: Blockly.Block,
  input = 'QUERY',
  negated = false,
): string {
  const expr = parseStack(block, input);
  return renderExpr(negated ? negateExpr(expr) : expr);
}

function lexiconCode(block: Blockly.Block): string {
  const name = String(block.getFieldValue('NAME') ?? '');
  if (!name) return '';
  const field = String(block.getFieldValue('FIELD') ?? '');
  return renderExpression(name, queryCode(block), field);
}

Generator.forBlock['lexicon'] =
Generator.forBlock['lexicon_value'] = (
  block: Blockly.Block,
): [string, number] => [lexiconCode(block), ORDER_NONE]

// The 或者 separator only splits the query stack; parseStack handles it.
Generator.forBlock['lexicon_or'] = () => ''

Generator.forBlock['lexicon_group'] = (block: Blockly.Block): string => {
  const group = String(block.getFieldValue('GROUP') ?? '');
  return renderExpr(
    applyGroup(
      parseStack(block, 'ITEM'),
      group,
      contextFor(block)?.meta,
    ),
  );
};

Generator.forBlock['lexicon_not'] = (block: Blockly.Block): string =>
  queryCode(block, 'ITEM', true);

Generator.forBlock['lexicon_pinyin'] = (block: Blockly.Block): string =>
  renderCondition(block, () => lex.pinyin(slotCode(block, 'PATTERN')));

Generator.forBlock['lexicon_length'] = (block: Blockly.Block): string => {
  const value = slotNumber(block, 'LENGTH');
  if (value === undefined) return '';
  return renderCondition(block, () =>
    lex.wordLength(
      value,
      String(block.getFieldValue('COMPARISON')) as LengthComparison,
    ),
  );
};

Generator.forBlock['lexicon_path'] = (block: Blockly.Block): string => {
  const segments = slotCode(block, 'PATH')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const depth =
    block.getFieldValue('DEPTH') === 'descendants' ? 'descendants' : 'children';
  return renderCondition(block, () => lex.path(segments, depth));
};

Generator.forBlock['lexicon_enum'] = (block: Blockly.Block): string =>
  renderCondition(block, () =>
    lex.enum(String(block.getFieldValue('VALUE') ?? '')),
  );

Generator.forBlock['lexicon_index'] = (block: Blockly.Block): string => {
  const start = slotNumber(block, 'START');
  const end = slotNumber(block, 'END');
  if (start === undefined || end === undefined) return '';
  return renderCondition(block, () => lex.index(start, end));
};

Generator.forBlock['lexicon_regex'] = (block: Blockly.Block): string =>
  renderCondition(block, () => lex.regex(slotCode(block, 'SOURCE')));

// Math =======================================================================

/** Codes of an n-ary ITEM0.. input list. */
function naryCodes(block: Blockly.Block): string[] {
  const codes: string[] = []
  for (let index = 0; block.getInput(`ITEM${index}`); index++) {
    const code = Generator.valueToCode(block, `ITEM${index}`, ORDER_NONE)
    if (code) codes.push(code)
  }
  return codes
}

Generator.forBlock['number'] = (block: Blockly.Block): [string, number] => [
  translate(Symbols.Immediate + slotCode(block, 'TEXT')),
  ORDER_NONE,
]

Generator.forBlock['choice'] = (block: Blockly.Block): [string, number] => {
  const items = naryCodes(block)
  return items.length
    ? [translate(items.join(' ')), ORDER_NONE]
    : ['', ORDER_NONE]
}

function rangeCode(block: Blockly.Block): string {
  const left = escapedSlotText(block, 'LEFT')
  const right = escapedSlotText(block, 'RIGHT')
  if (!left || !right) return ''

  const fspec = slotText(block, 'FSPEC')
  const fusr = String(block.getFieldValue('FUSR') ?? '')
  const dist = String(block.getFieldValue('DIST') ?? '')
  const rname = slotText(block, 'RNAME')
  const cname = slotText(block, 'CNAME')
  const count = slotText(block, 'COUNT')

  let code = `${left}-${right}`
  if (fspec) code += `:${fspec}${fusr ? `;${fusr}` : ''}`
  else if (fusr) code += `:${fusr}`
  if (dist) code += `@${dist}`
  if (rname) code += `<${rname}`
  if (cname) code += `>${cname}`
  if (count) code += `${block.getFieldValue('CSEP') ?? ''}=${count}`
  return translate(code)
}

Generator.forBlock['range'] =
Generator.forBlock['range_value'] = (
  block: Blockly.Block,
): [string, number] => [rangeCode(block), ORDER_NONE]

Generator.forBlock['format'] = (block: Blockly.Block): [string, number] => {
  const body = slotCode(block, 'BODY')
  const fspec = slotText(block, 'FSPEC')
  const fusr = String(block.getFieldValue('FUSR') ?? '')
  const cname = slotText(block, 'CNAME')
  if (!body) return ['', ORDER_NONE]
  if (!fspec && !fusr) return [body, ORDER_NONE]
  let code = `${body}:${fspec}`
  // The glyph separator is only accepted together with a format spec; with no
  // spec the glyph follows the colon directly (`[[3:cn]]`).
  if (fspec && fusr) code += `;${fusr}`
  else if (fusr) code += fusr
  if (cname) code += `>${cname}`
  return [translate(code), ORDER_NONE]
}

Generator.forBlock['reduce_calc'] = (block: Blockly.Block): [string, number] => {
  const op = fieldText(block, 'OP')
  const sep = String(block.getFieldValue('SEP') ?? '') || '，'
  const items = naryCodes(block)
  if (!op || !items.length) return ['', ORDER_NONE]
  return [translate(`#${op} ${items.join(sep)}`), ORDER_NONE]
}

Generator.forBlock['calculate'] = (block: Blockly.Block): [string, number] => [
  translate(Symbols.Calculate + slotCode(block, 'TEXT')),
  ORDER_NONE,
]

// Controls ===================================================================

Generator.forBlock['controls_repeat'] = (
  block: Blockly.Block,
): [string, number] => {
  const times = slotText(block, 'TIMES');
  const bodyBlock = block.getInputTargetBlock('BODY');
  const body = bodyBlock
    ? extractCode(Generator.blockToCode(bodyBlock))
    : '';
  const lazy = block.getFieldValue('LAZY');
  if (!times) return ['', ORDER_NONE];
  const symbol = lazy === 'TRUE' ? Symbols.RepeatLazy : Symbols.Repeat;
  return [translate(body + symbol + times), ORDER_NONE];
}

// Variables ==================================================================

Generator.forBlock['variables_set'] = (
  block: Blockly.Block,
): [string, number] => {
  const value = slotCode(block, 'BODY');
  const name = block.getField('VAR')!.getText();
  const echo = block.getFieldValue('ECHO') === 'TRUE';
  return [
    translate(value + Symbols.Cache + name + (echo ? Symbols.Cache : '')),
    ORDER_NONE,
  ];
}

Generator.forBlock['variables_set_block'] = (
  block: Blockly.Block,
): [string, number] => {
  const value = slotCode(block, 'BODY');
  const name = slotCode(block, 'VAR');
  const echo = block.getFieldValue('ECHO') === 'TRUE';
  return [
    translate(value + Symbols.Cache + name + (echo ? Symbols.Cache : '')),
    ORDER_NONE,
  ];
}

function variablesGetCode(block: Blockly.Block): string {
  const name = block.getField('VAR')!.getText();
  return translate(Symbols.Reference + name);
}

Generator.forBlock['variables_get'] =
Generator.forBlock['variables_get_value'] = (
  block: Blockly.Block,
): [string, number] => [variablesGetCode(block), ORDER_NONE]

function lingerGetCode(block: Blockly.Block): string {
  return translate(Symbols.LingerRef + slotText(block, 'SCOPE'));
}

Generator.forBlock['variables_get_linger'] =
Generator.forBlock['variables_get_linger_value'] = (
  block: Blockly.Block,
): [string, number] => [lingerGetCode(block), ORDER_NONE]

Generator.forBlock['variables_set_linger'] = (
  block: Blockly.Block,
): [string, number] => {
  const name = block.getField('VAR')!.getText();
  const scope = slotText(block, 'SCOPE');
  return [translate(name + Symbols.LingerAssign + scope), ORDER_NONE];
}

Generator.forBlock['inner_value_set'] = (
  block: Blockly.Block,
): [string, number] => {
  const body = slotCode(block, 'BODY')
  const field = slotText(block, 'FIELD')
  const name = slotText(block, 'NAME')
  const echo = block.getFieldValue('ECHO') === 'TRUE'
  if (!body || !field || !name) return ['', ORDER_NONE]
  return [
    translate(`${body}>>${field}:${name}${echo ? '>' : ''}`),
    ORDER_NONE,
  ]
}

function innerValueGetCode(block: Blockly.Block): string {
  const field = slotText(block, 'FIELD')
  const name = slotText(block, 'NAME')
  if (!name) return ''
  return translate(`<<${field ? `${field}:` : ''}${name}`)
}

Generator.forBlock['inner_value_get'] =
Generator.forBlock['inner_value_get_value'] = (
  block: Blockly.Block,
): [string, number] => [innerValueGetCode(block), ORDER_NONE]

// Settings ===================================================================

Generator.forBlock['config'] = (block: Blockly.Block): [string, number] => [
  translate(`config<${fieldText(block, 'ITEM')}>`),
  ORDER_NONE,
]

Generator.forBlock['nocensor'] = (block: Blockly.Block): [string, number] => {
  const otp = slotText(block, 'OTP').toUpperCase()
  return [translate('nocensor' + (otp ? ` ${otp}` : '')), ORDER_NONE]
}

Generator.forBlock['reset'] = (block: Blockly.Block): [string, number] => {
  const seed = slotText(block, 'SEED')
  return [translate('RST' + (seed ? ` ${seed}` : '')), ORDER_NONE]
}

// Dual connections ===========================================================
//
// A block whose output is connected is a value; otherwise it is a line in a
// vertical concatenation chain, so its generator returns plain string code.

for (const [type, generate] of Object.entries(Generator.forBlock)) {
  const wrapped: typeof generate = (block, generator) => {
    const result = generate(block, generator);
    if (Array.isArray(result) && !block.outputConnection?.targetConnection)
      return result[0];
    return result;
  };
  Generator.forBlock[type] = wrapped;
}
