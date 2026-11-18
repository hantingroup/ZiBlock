import * as Blockly from 'blockly';
import {
  getCachedLexiconMeta,
  groupSupportsCondition,
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
  effectiveConditionKind,
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

/** Code of a statement input, including its chained siblings. */
function statementCode(block: Blockly.Block, input: string): string {
  return blockToCode(block.getInputTargetBlock(input))
}

function joinBlock(
  block: Blockly.Block | null,
  sep: string | null = null,
  code: string = extractCode(Generator.blockToCode(block)),
): string {
  const nextBlock = block?.nextConnection?.targetBlock();
  if (sep !== null && nextBlock)
    code += sep + joinBlock(nextBlock, sep);
  return code;
}

function blockToCode(
  block: Blockly.Block | null,
  code: string = extractCode(Generator.blockToCode(block)),
): string {
  return joinBlock(block, '', code);
}

Generator.scrub_ = (block: Blockly.Block, code: string, thisOnly: boolean) => {
  if (!block.getParent())
    code = joinBlock(block, '', code)
  return code;
}

// Value slots ================================================================

Generator.forBlock['literal_text'] =
Generator.forBlock['literal_multiline'] =
Generator.forBlock['literal_number'] = (block: Blockly.Block): [string, number] => [
  String(block.getFieldValue('TEXT') ?? ''),
  ORDER_NONE,
]

// Text =======================================================================

Generator.forBlock['text_multiline'] =
Generator.forBlock['text'] = (block: Blockly.Block) => {
    return slotCode(block, 'TEXT');
  }

Generator.forBlock['translate_multiline'] =
Generator.forBlock['translate'] = (block: Blockly.Block) => {
    return translate(slotCode(block, 'TEXT'));
  }

Generator.forBlock['translate_block'] = (block: Blockly.Block) => {
  return translate(escape(blockToCode(block.getInputTargetBlock('BODY'))));
}

Generator.forBlock['slice'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const start = slotText(block, 'START')
  const stop = slotText(block, 'STOP')
  const step = slotText(block, 'STEP')
  if (!body) return ''
  if (!start && !stop && !step) return body
  let code = `${body}:${start}`
  if (stop || step) code += `:${stop}`
  if (step) code += `:${step}`
  return translate(code)
}

Generator.forBlock['transform'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const op = fieldText(block, 'OP')
  const cname = slotText(block, 'CNAME')
  if (!body || !op) return ''
  let code = `${body}:${op}`
  if (!isFilterOp(op)) {
    const charset = escapedSlotText(block, 'CHARSET', false)
    if (charset) code += `@${charset}`
  }
  if (cname) code += `>${cname}`
  return translate(code)
}

function aliasCode(block: Blockly.Block): string {
  const alias = fieldText(block, 'ALIAS')
  if (!alias) return ''
  return translate(alias)
}

Generator.forBlock['alias'] = aliasCode

Generator.forBlock['alias_value'] = (block: Blockly.Block): [string, number] => [
  aliasCode(block),
  ORDER_NONE,
]

Generator.forBlock['join'] = (block: Blockly.Block): [string, number] => [
  slotCode(block, 'A') + slotCode(block, 'B'),
  ORDER_NONE,
]

// Lexicon ====================================================================

/**
 * Lexicon context for query generation. Queries normally hang off a lexicon
 * block (or its gear-bubble root), but a saved query tree is regenerated in a
 * throwaway workspace that has no such parent, so the context is passed
 * explicitly while that happens.
 */
let queryContext: { name: string; meta?: LexiconMeta } | undefined;

function contextFor(block: Blockly.Block): {
  name: string;
  meta?: LexiconMeta;
} | undefined {
  if (queryContext) return queryContext;
  const lexicon = findEnclosingLexicon(block);
  if (!lexicon) return undefined;
  const name = lexiconBlockName(lexicon);
  return { name, meta: name ? getCachedLexiconMeta(name) : undefined };
}

function withQueryContext<T>(name: string, fn: () => T): T {
  const previous = queryContext;
  queryContext = { name, meta: name ? getCachedLexiconMeta(name) : undefined };
  try {
    return fn();
  } finally {
    queryContext = previous;
  }
}

/** One slot inside a branch: a condition/segment and its own flags. */
export interface QueryBranchItemState {
  not?: boolean;
  /** Schema group for this slot (`@组`). */
  group?: string;
  state: Blockly.serialization.blocks.State;
}

/** One AND branch; its slots are joined with & and branches are joined with |. */
export interface QueryBranchState {
  items: QueryBranchItemState[];
}

/** Code of one slot inside a branch. A group stays with its own slot. */
function branchItemCode(block: Blockly.Block): { code: string; group?: string } {
  if (block.type === 'lexicon_group') {
    return {
      code: Generator.valueToCode(block, 'ITEM', ORDER_NONE),
      group: String(block.getFieldValue('GROUP') ?? '') || undefined,
    };
  }
  return { code: extractCode(Generator.blockToCode(block)) };
}

/**
 * Renders one branch slot as a DSL segment. A slot group overrides the item's
 * own group; the group annotation is applied outside the negation:
 * `!(=2)@词` is accepted, while `!(=2@词)` is rejected by the fill-in engine.
 */
function renderItem(
  block: Blockly.Block,
  not: boolean,
  groupOverride?: string,
): string {
  const { code, group } = branchItemCode(block);
  if (!code) return '';
  const core = not ? `!(${code})` : code;
  const effective = groupOverride || group;
  return effective ? `${core}@${effective}` : core;
}

function renderBranchState(branch: QueryBranchState): string {
  const workspace = new Blockly.Workspace();
  try {
    const codes: string[] = [];
    for (const item of branch.items) {
      const block = Blockly.serialization.blocks.append(item.state, workspace);
      const code = renderItem(block, !!item.not, item.group);
      if (code) codes.push(code);
    }
    return codes.join('&');
  } finally {
    workspace.dispose();
  }
}

/** Generates the DSL for serialized query branches (lexicon block extra state). */
export function queryDslFromBranches(
  branches: readonly QueryBranchState[] | null | undefined,
  name: string,
): string {
  if (!branches?.length) return '';
  return withQueryContext(name, () => {
    const codes: string[] = [];
    for (const branch of branches) {
      try {
        const code = renderBranchState(branch);
        if (code) codes.push(code);
      } catch {
        // A branch that cannot be deserialized contributes nothing.
      }
    }
    return codes.join('|');
  });
}

/** Renders one condition block as a DSL segment, validating against meta. */
function renderCondition(
  block: Blockly.Block,
  build: () => Condition,
): string {
  const context = contextFor(block);
  if (!context) return '';
  try {
    return lexiconQuery(segment(build()), context.meta).build();
  } catch (error) {
    // Incomplete or invalid conditions simply contribute no segment.
    if (error instanceof LexiconQueryError) return '';
    throw error;
  }
}

Generator.forBlock['lexicon_group'] = (block: Blockly.Block): [string, number] => {
  const item = Generator.valueToCode(block, 'ITEM', ORDER_NONE);
  const group = String(block.getFieldValue('GROUP') ?? '');
  if (!item || !group) return [item, 3];

  const meta = contextFor(block)?.meta;
  const kind = effectiveConditionKind(block.getInputTargetBlock('ITEM'));
  // The UI already warns about unsupported pairs; don't drop the whole query.
  if (meta && kind && !groupSupportsCondition(meta, group, kind))
    return [item, 3];

  return [`${item}@${group}`, 3];
};

/** Shape of the extra state stored on the lexicon block (see lexicon-mutator). */
type LexiconQueryState = Blockly.Block & {
  queryBranches?: QueryBranchState[] | null;
};

function lexiconCode(block: Blockly.Block): string {
  const name = String(block.getFieldValue('NAME') ?? '');
  if (!name) return '';
  const field = String(block.getFieldValue('FIELD') ?? '');
  const branches = (block as LexiconQueryState).queryBranches ?? [];
  return renderExpression(name, queryDslFromBranches(branches, name), field);
}

Generator.forBlock['lexicon'] = lexiconCode

Generator.forBlock['lexicon_value'] = (
  block: Blockly.Block,
): [string, number] => [lexiconCode(block), ORDER_NONE]

Generator.forBlock['lexicon_not'] = (block: Blockly.Block): [string, number] => {
  const item = Generator.valueToCode(block, 'ITEM', ORDER_NONE);
  return item ? [`!(${item})`, 3] : ['', 3];
}

function renderLogic(
  block: Blockly.Block,
  joiner: '&' | '|',
  precedence: number,
): [string, number] {
  const parts: string[] = [];
  for (let index = 0; block.getInput(`ITEM${index}`); index++) {
    const code = Generator.valueToCode(block, `ITEM${index}`, ORDER_NONE);
    if (code) parts.push(code);
  }
  return [parts.join(joiner), precedence];
}

Generator.forBlock['lexicon_and'] = (block: Blockly.Block) =>
  renderLogic(block, '&', 2);

Generator.forBlock['lexicon_or'] = (block: Blockly.Block) =>
  renderLogic(block, '|', 1);

Generator.forBlock['lexicon_pinyin'] = (block: Blockly.Block): [string, number] => [
  renderCondition(block, () => lex.pinyin(slotCode(block, 'PATTERN'))),
  3,
];

Generator.forBlock['lexicon_length'] = (
  block: Blockly.Block,
): [string, number] => {
  const value = slotNumber(block, 'LENGTH');
  if (value === undefined) return ['', 3];
  return [
    renderCondition(block, () =>
      lex.wordLength(
        value,
        String(block.getFieldValue('COMPARISON')) as LengthComparison,
      ),
    ),
    3,
  ];
};

Generator.forBlock['lexicon_path'] = (block: Blockly.Block): [string, number] => {
  const segments = slotCode(block, 'PATH')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const depth =
    block.getFieldValue('DEPTH') === 'descendants' ? 'descendants' : 'children';
  return [renderCondition(block, () => lex.path(segments, depth)), 3];
}

Generator.forBlock['lexicon_enum'] = (block: Blockly.Block): [string, number] => [
  renderCondition(block, () =>
    lex.enum(String(block.getFieldValue('VALUE') ?? '')),
  ),
  3,
];

Generator.forBlock['lexicon_index'] = (block: Blockly.Block): [string, number] => {
  const start = slotNumber(block, 'START');
  const end = slotNumber(block, 'END');
  if (start === undefined || end === undefined) return ['', 3];
  return [renderCondition(block, () => lex.index(start, end)), 3];
};

Generator.forBlock['lexicon_regex'] = (block: Blockly.Block): [string, number] => [
  renderCondition(block, () => lex.regex(slotCode(block, 'SOURCE'))),
  3,
];

// Math =======================================================================

Generator.forBlock['number'] = (block: Blockly.Block) => {
  return translate(Symbols.Immediate + slotCode(block, 'TEXT'));
}

Generator.forBlock['choice'] = (block: Blockly.Block) => {
  const body = block.getInputTargetBlock('BODY');
  return translate(body && joinBlock(body, ' '));
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

Generator.forBlock['range'] = rangeCode

Generator.forBlock['range_value'] = (
  block: Blockly.Block,
): [string, number] => [rangeCode(block), ORDER_NONE]

Generator.forBlock['format'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const fspec = slotText(block, 'FSPEC')
  const fusr = String(block.getFieldValue('FUSR') ?? '')
  const cname = slotText(block, 'CNAME')
  if (!body) return ''
  if (!fspec && !fusr) return body
  let code = `${body}:${fspec}`
  // The glyph separator is only accepted together with a format spec; with no
  // spec the glyph follows the colon directly (`[[3:cn]]`).
  if (fspec && fusr) code += `;${fusr}`
  else if (fusr) code += fusr
  if (cname) code += `>${cname}`
  return translate(code)
}

Generator.forBlock['reduce_calc'] = (block: Blockly.Block) => {
  const op = fieldText(block, 'OP')
  const sep = String(block.getFieldValue('SEP') ?? '') || '，'
  const body = block.getInputTargetBlock('BODY')
  if (!body) return ''
  return translate(`#${op} ${joinBlock(body, sep)}`)
}

Generator.forBlock['calculate'] = (block: Blockly.Block) => {
  return translate(Symbols.Calculate + slotCode(block, 'TEXT'));
}

// Controls ===================================================================

Generator.forBlock['controls_repeat'] = (block: Blockly.Block) => {
  const times = slotText(block, 'TIMES');
  const body = block.getInputTargetBlock('BODY');
  const lazy = block.getFieldValue('LAZY');
  if (!times) return '';
  const symbol = lazy === 'TRUE' ? Symbols.RepeatLazy : Symbols.Repeat;
  return translate(blockToCode(body) + symbol + times);
}

// Variables ==================================================================

Generator.forBlock['variables_set'] = (block: Blockly.Block) => {
  const value = blockToCode(block.getInputTargetBlock('BODY'));
  const name = block.getField('VAR')!.getText();
  const echo = block.getFieldValue('ECHO') === 'TRUE';
  return translate(value + Symbols.Cache + name + (echo ? Symbols.Cache : ''));
}

Generator.forBlock['variables_set_block'] = (block: Blockly.Block) => {
  const value = blockToCode(block.getInputTargetBlock('BODY'));
  const name = blockToCode(block.getInputTargetBlock('VAR'));
  const echo = block.getFieldValue('ECHO') === 'TRUE';
  return translate(value + Symbols.Cache + name + (echo ? Symbols.Cache : ''));
}

function variablesGetCode(block: Blockly.Block): string {
  const name = block.getField('VAR')!.getText();
  return translate(Symbols.Reference + name);
}

Generator.forBlock['variables_get'] = variablesGetCode

Generator.forBlock['variables_get_value'] = (
  block: Blockly.Block,
): [string, number] => [variablesGetCode(block), ORDER_NONE]

function lingerGetCode(block: Blockly.Block): string {
  return translate(Symbols.LingerRef + slotText(block, 'SCOPE'));
}

Generator.forBlock['variables_get_linger'] = lingerGetCode

Generator.forBlock['variables_get_linger_value'] = (
  block: Blockly.Block,
): [string, number] => [lingerGetCode(block), ORDER_NONE]

Generator.forBlock['variables_set_linger'] = (block: Blockly.Block) => {
  const name = block.getField('VAR')!.getText();
  const scope = slotText(block, 'SCOPE');
  return translate(name + Symbols.LingerAssign + scope);
}

Generator.forBlock['inner_value_set'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const field = slotText(block, 'FIELD')
  const name = slotText(block, 'NAME')
  const echo = block.getFieldValue('ECHO') === 'TRUE'
  if (!body) return ''
  if (!field) return ''
  if (!name) return ''
  return translate(`${body}>>${field}:${name}${echo ? '>' : ''}`)
}

function innerValueGetCode(block: Blockly.Block): string {
  const field = slotText(block, 'FIELD')
  const name = slotText(block, 'NAME')
  if (!name) return ''
  return translate(`<<${field ? `${field}:` : ''}${name}`)
}

Generator.forBlock['inner_value_get'] = innerValueGetCode

Generator.forBlock['inner_value_get_value'] = (
  block: Blockly.Block,
): [string, number] => [innerValueGetCode(block), ORDER_NONE]

// Settings ===================================================================

Generator.forBlock['config'] = (block: Blockly.Block) => {
  return translate(`config<${fieldText(block, 'ITEM')}>`)
}

Generator.forBlock['nocensor'] = (block: Blockly.Block) => {
  const otp = slotText(block, 'OTP').toUpperCase()
  return translate('nocensor' + (otp ? ` ${otp}` : ''))
}

Generator.forBlock['reset'] = (block: Blockly.Block) => {
  const seed = slotText(block, 'SEED')
  return translate('RST' + (seed ? ` ${seed}` : ''))
}
