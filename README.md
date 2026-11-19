# ZiBlock

用积木拼出[填字（Tianzi）](https://tianzi.hongbot.icu/howto)指令的网页编辑器。

画布上的每个积木都是一个字符串表达式；所有顶层积木按顺序拼接成一段填字 DSL，
既可以在右侧直接查看生成的文本，也可以发给 Tianzi 服务执行并显示结果。
反过来，粘贴一段填字文本，也能通过服务端返回的语法树还原成积木。

## 技术栈

- **Svelte 5**（runes）+ **TypeScript**
- **Vite 8** 构建，`@modyfi/vite-plugin-yaml` 加载积木定义
- **Blockly 13** 提供画布、飞出菜单与序列化
- **runed** 的 `resource` 负责编译结果请求与去抖/取消
- 包管理器：**Bun**

## 快速开始

```sh
bun install
bun run dev       # 开发服务器
bun run build     # 生产构建
bun run preview   # 预览构建产物
bun run check     # svelte-check + tsc
```

开发模式下画布会暂存在 `sessionStorage`（`ziblock:workspace`），刷新页面不丢失；
该持久化只在 Vite HMR/开发模式启用。

## 目录结构

```
src/
├── App.svelte              应用外壳：画布、编译结果面板、文本导入对话框
├── main.ts                 挂载入口
├── app.css                 全局变量与基础样式
└── lib/
    ├── Workspace.svelte    注入 Blockly、生成文本、恢复/保存画布、导入接口
    ├── index.ts            注册语言包、字段、积木、YAML 定义、宏表预热
    ├── blocks.yml          积木定义（YAML，加载时转换为 Blockly JSON）
    ├── toolbox.yml         工具箱分类
    ├── generator.ts        填字 DSL 代码生成器（Blockly.Generator）
    ├── shadow-slots.ts     文本/数字字段 → 可替换的值槽 + 影子积木
    ├── dual-connections.ts 表达式积木同时具备语句连接
    ├── nary-inputs.ts      choice / reduce_calc 的动态多路输入
    ├── transforms.ts       字体/滤镜二合一选择器
    ├── macros.ts           远程宏表（alias.tsv）与缓存
    ├── dropdown-field.ts   可搜索的长下拉菜单基类
    ├── block-state.ts      无输出的积木自动置灰
    ├── theme.ts / fonts.ts 主题与字体别名
    ├── tianzi.ts           Tianzi 执行/AST 接口客户端
    ├── text-import.ts      语法树 → 积木（文本导入）
    └── lexicons/           词库接口、查询 DSL、字段、校验、条件面板
        ├── api.ts          词库列表 / 元信息缓存
        ├── query.ts        查询 DSL 构造与校验
        ├── blocks.ts       词库积木注册与联动
        ├── fields.ts       词库名/组/输出列/枚举/宏 字段
        ├── palette.ts      查询条件的齿轮飞出菜单
        ├── validation.ts   查询块的警告与跨块校验
        └── context.ts      查找所属词库/组
```

## 核心概念

### 积木即字符串

每个通用积木都输出 `String`，并通过 `dual_connection` 扩展同时拥有语句连接：

- 接在值输入上时，它是表达式（`Generator.valueToCode`）；
- 串在语句链上时，它是文本拼接的一行。

`Generator.workspaceToCode` 被改写为直接拼接所有顶层积木（不插换行），
与 DSL 的「顶层表达式直接拼接」语义一致。

### 值槽与影子积木

Blockly 的字段不能接收积木。`blocks.yml` 仍写 `field_input` / `field_number` /
`field_multilinetext`，加载时 `prepareShadowSlots` 会把它们改写成值输入，
并放入一个可编辑的「字面量」影子积木（`literal_text` / `literal_number` / …）。
这样既保留了原地输入框的体验，又允许把任意表达式拖进去替换。

### 词库查询

词库积木是 C 形结构，查询条件按行「与」组合，`或者` 分隔「或」分支，
`取反` / `组` 是包裹条件栈的 C 形积木。生成时会做德摩根展开与 DNF 展开，
输出形如 `/辽宁省/沈阳市/**&#地级市#@类型` 的查询串。

词库列表与列信息来自 `https://tianzi.hongbot.icu/api/lex/*`，同名请求会被缓存/去重。

### 宏

`macro` 积木引用远程宏表（`reserved/alias.tsv`），生成 `[[宏名]]`。
宏表拉取失败时使用内置的 `一/二/三` 作为回退。

## 从文本导入积木

点击右下角「从文本导入」，粘贴一段填字指令，例如：

```
你好[[#5]]
[[1-9:.2f;d@n<读>写，=3]]
```

流程：

1. `src/lib/tianzi.ts` 调用 `POST /api/tianzi`，请求体带上 `stack: true`；
2. 服务端返回每个 `[[…]]` 字段的语法候选（`syntax`、`status`、`groups`、
   `children`），词库查询还会给出 `query.ast`；
3. `src/lib/text-import.ts` 按字段位置还原积木，`[[…]]` 之外的非空文本还原为
   「文本」积木，最后串成一条语句链追加到画布上。

优先级规则：`ok` > `raised:*` > 具体的 `rejected` 候选；
`Alias` / `Lex` / `Choice` 这类几乎能匹配任意文本的候选，
只有在服务端明确判定为 `ok` 或 `raised` 时才会采用，避免把解析失败的文本
误认成宏或词库。无法识别的字段会提示具体文本，不会静默丢弃。

已知限制：

- 选择/归约块的候选项以分隔符切分，字面量里本身含有该分隔符时存在歧义；
- 引擎把翻译器正则按 `VERBOSE` 编译，`Reset` 模式 `RST(?P<seed> [0-9]+)?`
  里的空格会被忽略，所以实际语法是 `[[RST123456]]`（无空格）；
  官方手册写的 `[[RST 123456]]` 会落到「选择」语法。本项目的重置积木已按
  无空格形式生成；从别处粘贴带空格的 `[[RST 42]]` 时，会忠实还原成选择块。

## 远程服务与部署

- 词库与执行服务：`https://tianzi.hongbot.icu`
- 宏表：GitHub 上的 `reserved/alias.tsv`（站点自身接口需要登录与 Turnstile）
- 部署：推送到 `master` 后由 `.github/workflows/deploy.yml` 发布到 GitHub Pages，
  `vite.config.ts` 的 `base` 会取仓库名（默认 `/ZiBlock/`）。
