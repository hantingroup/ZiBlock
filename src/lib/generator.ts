import * as Blockly from 'blockly';
import {
  getCachedLexiconMeta,
  groupSupportsCondition,
  lex,
  lexiconQuery,
  renderExpression,
  segment,
  type Condition,
  type LengthComparison,
  type LexiconMeta,
} from './lexicons';
import {
  conditionKindLabel,
  effectiveConditionKind,
  findEnclosingLexicon,
  lexiconBlockName,
} from './lexicon-ui';

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

// Text =======================================================================

Generator.forBlock['text_multiline'] =
Generator.forBlock['text'] = (block: Blockly.Block) => {
    return block.getFieldValue('TEXT');
  }

Generator.forBlock['translate_multiline'] =
Generator.forBlock['translate'] = (block: Blockly.Block) => {
    return translate(block.getFieldValue('TEXT'));
  }

Generator.forBlock['translate_block'] = (block: Blockly.Block) => {
  return translate(escape(blockToCode(block.getInputTargetBlock('BODY'))));
}

Generator.forBlock['slice'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const start = fieldText(block, 'START')
  const stop = fieldText(block, 'STOP')
  const step = fieldText(block, 'STEP')
  if (!body) throw new Error('切片需要一个目标')
  if (!start && !stop && !step) throw new Error('切片至少需要一个索引')
  let code = `${body}:${start}`
  if (stop || step) code += `:${stop}`
  if (step) code += `:${step}`
  return translate(code)
}

Generator.forBlock['font'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const font = fieldText(block, 'FONT')
  const charset = String(block.getFieldValue('CHARSET') ?? '')
  const cname = fieldText(block, 'CNAME')
  if (!body) throw new Error('字体转换需要一个目标')
  if (!font) throw new Error('请选择字体')
  let code = `${body}:${font}`
  if (charset) code += `@${escape(charset)}`
  if (cname) code += `>${cname}`
  return translate(code)
}

Generator.forBlock['filter'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const op = fieldText(block, 'OP')
  const cname = fieldText(block, 'CNAME')
  if (!body) throw new Error('滤镜需要一个目标')
  if (!op) throw new Error('请选择滤镜')
  return translate(`${body}:${op}${cname ? `>${cname}` : ''}`)
}

Generator.forBlock['alias'] = (block: Blockly.Block) => {
  const alias = fieldText(block, 'ALIAS')
  if (!alias) throw new Error('请选择或输入别名')
  return translate(alias)
}

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
} {
  if (queryContext) return queryContext;
  const lexicon = findEnclosingLexicon(block);
  if (!lexicon) throw new Error('查询条件需要放在词库积木的查询里');
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

/** Generates the DSL for a query tree that lives in a workspace. */
export function queryBlockToDsl(block: Blockly.Block | null): string {
  return block ? extractCode(Generator.blockToCode(block)) : '';
}

function isQueryBlock(block: Blockly.Block): boolean {
  return !!block.outputConnection?.getCheck()?.includes('TzQuery');
}

interface QueryPart {
  code: string;
  isQuery: boolean;
}

/**
 * Joins slots into one DSL clause. A `或` expression needs parentheses to be
 * ANDed with anything else, which the fill-in language does not allow, so it
 * has to stay on its own.
 */
function joinQueryParts(parts: readonly QueryPart[]): string {
  const filled = parts.filter((part) => part.code);
  if (filled.length > 1 && filled.some((part) => part.isQuery))
    throw new Error('“或”需要单独作为一个查询，不能和其它条件并列');
  return filled.map((part) => part.code).join('&');
}

/** Joins the blocks sitting in a multi-input block's slots into one DSL clause. */
export function joinQueryBlocks(blocks: readonly Blockly.Block[]): string {
  return joinQueryParts(
    blocks.map((block) => ({
      code: queryBlockToDsl(block),
      isQuery: isQueryBlock(block),
    })),
  );
}

/** Generates the DSL for serialized query trees (lexicon block extra state). */
export function queryDslFromStates(
  states: readonly Blockly.serialization.blocks.State[] | null | undefined,
  name: string,
): string {
  if (!states?.length) return '';
  return withQueryContext(name, () => {
    const parts: QueryPart[] = [];
    for (const state of states) {
      const workspace = new Blockly.Workspace();
      try {
        const tree = Blockly.serialization.blocks.append(state, workspace);
        parts.push({ code: queryBlockToDsl(tree), isQuery: isQueryBlock(tree) });
      } finally {
        workspace.dispose();
      }
    }
    return joinQueryParts(parts);
  });
}

/** Renders one condition block as a DSL segment, validating against meta. */
function renderCondition(block: Blockly.Block, condition: Condition): string {
  const { meta } = contextFor(block);
  return lexiconQuery(segment(condition), meta).build();
}

Generator.forBlock['lexicon_group'] = (block: Blockly.Block): [string, number] => {
  const item = Generator.valueToCode(block, 'ITEM', ORDER_NONE);
  const group = String(block.getFieldValue('GROUP') ?? '');
  if (!item || !group) return [item, 3];

  const { meta } = contextFor(block);
  const kind = effectiveConditionKind(block.getInputTargetBlock('ITEM'));
  if (meta && kind && !groupSupportsCondition(meta, group, kind))
    throw new Error(`组“${group}”不支持${conditionKindLabel(kind)}查询`);

  return [`${item}@${group}`, 3];
};

/** Shape of the extra state stored on the lexicon block (see lexicon-mutator). */
type LexiconQueryState = Blockly.Block & {
  queryStates?: Blockly.serialization.blocks.State[] | null;
};

Generator.forBlock['lexicon'] = (block: Blockly.Block) => {
  const name = String(block.getFieldValue('NAME') ?? '');
  const field = String(block.getFieldValue('FIELD') ?? '');
  const states = (block as LexiconQueryState).queryStates ?? [];
  return renderExpression(name, queryDslFromStates(states, name), field);
}

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
  renderCondition(block, lex.pinyin(String(block.getFieldValue('PATTERN') ?? ''))),
  3,
];

Generator.forBlock['lexicon_word_length'] = (
  block: Blockly.Block,
): [string, number] => [
  renderCondition(
    block,
    lex.wordLength(
      Number(block.getFieldValue('LENGTH')),
      String(block.getFieldValue('COMPARISON')) as LengthComparison,
    ),
  ),
  3,
];

Generator.forBlock['lexicon_path'] = (block: Blockly.Block): [string, number] => {
  const segments = String(block.getFieldValue('PATH') ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const depth =
    block.getFieldValue('DEPTH') === 'descendants' ? 'descendants' : 'children';
  return [renderCondition(block, lex.path(segments, depth)), 3];
}

Generator.forBlock['lexicon_enum'] = (block: Blockly.Block): [string, number] => [
  renderCondition(block, lex.enum(String(block.getFieldValue('VALUE') ?? ''))),
  3,
];

Generator.forBlock['lexicon_index'] = (block: Blockly.Block): [string, number] => [
  renderCondition(
    block,
    lex.index(
      Number(block.getFieldValue('START')),
      Number(block.getFieldValue('END')),
    ),
  ),
  3,
];

Generator.forBlock['lexicon_regex'] = (block: Blockly.Block): [string, number] => [
  renderCondition(block, lex.regex(String(block.getFieldValue('SOURCE') ?? ''))),
  3,
];

// Math =======================================================================

Generator.forBlock['number'] = (block: Blockly.Block) => {
  const body = block.getFieldValue('BODY');
  return translate(Symbols.Immediate + body);
}

Generator.forBlock['number_block'] = (block: Blockly.Block) => {
  const body = block.getInputTargetBlock('BODY');
  return translate(Symbols.Immediate + blockToCode(body));
}

Generator.forBlock['choice'] = (block: Blockly.Block) => {
  const body = block.getInputTargetBlock('BODY');
  return translate(body && joinBlock(body, ' '));
}

Generator.forBlock['range'] = (block: Blockly.Block) => {
  const left = fieldText(block, 'LEFT')
  const right = fieldText(block, 'RIGHT')
  if (!left || !right) throw new Error('随机数需要左右边界')

  const fspec = String(block.getFieldValue('FSPEC') ?? '').trim()
  const fusr = String(block.getFieldValue('FUSR') ?? '')
  const dist = String(block.getFieldValue('DIST') ?? '')
  const rname = fieldText(block, 'RNAME')
  const cname = fieldText(block, 'CNAME')
  const count = fieldText(block, 'COUNT')

  let code = `${escape(left)}-${escape(right)}`
  if (fspec) code += `:${fspec}${fusr ? `;${fusr}` : ''}`
  else if (fusr) code += `:${fusr}`
  if (dist) code += `@${dist}`
  if (rname) code += `<${rname}`
  if (cname) code += `>${cname}`
  if (count) code += `${block.getFieldValue('CSEP') ?? ''}=${count}`
  return translate(code)
}

Generator.forBlock['format'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const fspec = String(block.getFieldValue('FSPEC') ?? '').trim()
  const fusr = String(block.getFieldValue('FUSR') ?? '')
  const cname = fieldText(block, 'CNAME')
  if (!body) throw new Error('格式化需要一个目标')
  if (!fspec && !fusr) throw new Error('格式化需要格式或字形')
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
  if (!body) throw new Error('归约运算需要至少两段')
  return translate(`#${op} ${joinBlock(body, sep)}`)
}

Generator.forBlock['calculate'] = (block: Blockly.Block) => {
  const text = block.getFieldValue('BODY');
  return translate(Symbols.Calculate + text);
}

Generator.forBlock['calculate_block'] = (block: Blockly.Block) => {
  const body = block.getInputTargetBlock('BODY');
  return translate(Symbols.Calculate + blockToCode(body));
}

// Controls ===================================================================

Generator.forBlock['controls_repeat'] = (block: Blockly.Block) => {
  const times = block.getFieldValue('TIMES');
  const body = block.getInputTargetBlock('BODY');
  const lazy = block.getFieldValue('LAZY');
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

Generator.forBlock['variables_get'] = (block: Blockly.Block) => {
  const name = block.getField('VAR')!.getText();
  return translate(Symbols.Reference + name);
}

Generator.forBlock['variables_get_linger'] = (block: Blockly.Block) => {
  const name = block.getField('SCOPE')!.getText();
  return translate(Symbols.LingerRef + name);
}

Generator.forBlock['variables_set_linger'] = (block: Blockly.Block) => {
  const name = block.getField('VAR')!.getText();
  const scope = block.getFieldValue('SCOPE');
  return translate(name + Symbols.LingerAssign + scope);
}

Generator.forBlock['inner_value_set'] = (block: Blockly.Block) => {
  const body = statementCode(block, 'BODY')
  const field = fieldText(block, 'FIELD')
  const name = fieldText(block, 'NAME')
  const echo = block.getFieldValue('ECHO') === 'TRUE'
  if (!body) throw new Error('写入内部值需要一个值')
  if (!field) throw new Error('写入内部值需要作用域')
  if (!name) throw new Error('写入内部值需要一个名字')
  return translate(`${body}>>${field}:${name}${echo ? '>' : ''}`)
}

Generator.forBlock['inner_value_get'] = (block: Blockly.Block) => {
  const field = fieldText(block, 'FIELD')
  const name = fieldText(block, 'NAME')
  if (!name) throw new Error('读取内部值需要一个名字')
  return translate(`<<${field ? `${field}:` : ''}${name}`)
}

// Settings ===================================================================

Generator.forBlock['config'] = (block: Blockly.Block) => {
  return translate(`config<${fieldText(block, 'ITEM')}>`)
}

Generator.forBlock['nocensor'] = (block: Blockly.Block) => {
  const otp = fieldText(block, 'OTP').toUpperCase()
  return translate('nocensor' + (otp ? ` ${otp}` : ''))
}

Generator.forBlock['reset'] = (block: Blockly.Block) => {
  const seed = fieldText(block, 'SEED')
  if (seed && !/^[0-9]+$/.test(seed)) throw new Error('重置种子必须是数字')
  return translate('RST' + (seed ? ` ${seed}` : ''))
}
