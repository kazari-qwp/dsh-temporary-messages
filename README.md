# 临时消息 · dsh-temporary-messages

给 DSH 提供一条会过期的上下文消息通道，以及按 token 或推理步数刷新、可执行表达式的动态模板。

第一版针对 **DSH 0.2.2-rc.1、Node.js 22 及以上**。不需要修改 DSH 源码。

当前为实验版本，日志元数据依赖 DSH 限定于仓库内部使用的实验接口，详见下方「中断与恢复」。

## 使用

安装打包文件：

```powershell
dsh plugin --profile web add ".\dsh-temporary-messages-0.1.9.tgz"
```

也可以在 DSH 的插件管理页中安装这个 `.tgz` 文件路径。`web` 是使用的 profile，其他 profile 按实际名称替换。安装完成后刷新页面；没有启用 HMR 的宿主需要重启。

打开 **设置 → 临时消息**，编辑模板，点击「运行预览」，然后保存。默认模板只显示当前时间。留空模板时，其他插件仍能通过接口发送临时消息。

模板下方并列设置 **token 寿命**和 **步数限制 k**。只填一项就只按该项控制；两项都填时，任意一项先达到上限就撤下旧快照、重新执行模板，两个计数一起重置。两项都留空时按一次性处理；token 为 0 或 k 为 0 时也只使用一次。默认仍是每次推理更新。保存模板或寿命的新设置后，下一步立即开始新周期。

```text
当前时间：{{ new Date().toLocaleString("zh-CN", { hour12: false }) }}
当前会话：{{ session?.id }}
```

模板中的 `{{ ... }}` 是普通 JS 表达式，支持 `await`、取字段、计算和格式化。`null`、`undefined` 输出为空，对象输出为 JSON。

```text
剩余余额：{{ (await tool("get_balance", {})).balance.toFixed(2) }} 元
```

这里的 `get_balance` **只是示例**，需要你的 DSH 已注册相应工具。设置页会列出实际工具及参数说明，可以选择后插入调用。选择预览会话后，也会包含该会话可用的工具。

没有内置一张「时间、余额、用量变量表」。时间可以直接用 JS；其他信息可查询 DSH 服务或已注册工具。MCP 工具注册进 DSH 后，同样通过 `tool(工具名, 参数对象)` 调用。也可在表达式中使用 `fetch()` 等 Node.js 提供的函数。

`tool()` 返回工具的标准 `value`，执行经过 DSH 的工具策略；不会为求值额外调用模型，也不会把整个工具结果或附加上下文自动写入消息历史。模板在宿主进程执行，预览会实际运行表达式和工具，通常选择查询类工具。

## 在模板里直接写代码

`{{ ... }}` 可以包含异步函数，`return` 的值就是最终文字。模板可使用以下参数：

| 参数 | 内容 |
| --- | --- |
| `ctx` | 当前 Agent 的 Cordis 上下文；无会话预览时使用插件上下文 |
| `agent` | 当前 Agent；无会话预览时为 `null` |
| `session` | 完整的 `agent.session`，可以读取历史和调用会话方法；无会话预览时为 `null` |
| `modelSelection` | 本推理步骤使用的模型选择；预览时读取所选 Agent 的选择 |
| `signal` | 本次执行的取消信号，可传给 `fetch()` |
| `tool(name, args)` | 调用已注册的工具 |

用 **`ctx.get('服务名')`** 动态读取服务。这是 Cordis 的正式接口，不要求提前把每个服务名写进插件的 `inject`，也不用增加一套固定变量。`ctx`、`agent`、`session` 都是宿主中的实际对象，函数调用和写入会真实生效。

比如计算当前会话占比：

```text
上下文已用{{ (() => {
  if (!session) return '未知';
  const meter = ctx.get('tokenMeter');
  const { contextWindow } = meter.contextPressure(session);
  if (!contextWindow) return '未知';
  return (meter.measure(session).totalTokens / contextWindow * 100).toFixed(2);
})() }}%
```

完整的两行余额、上下文模板在 [`examples/balance-context.txt`](examples/balance-context.txt)，复制到设置页即可。查询、计算和文字都属于这份可编辑模板，插件本身不依赖账户或 token 统计服务。

该模板把人民币充值余额与赠送余额相加，显示两位小数，不进行汇率换算；账户查询失败或尚无窗口信息时显示「未知」。占比使用 DSH 的上下文估算，包含本轮已入日志的输入和工具信息，不包含这条状态消息自身。预览占比需要选择会话。

## 给其他插件的接口

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-temporary-messages'

export const inject = ['temporaryMessages', 'agents']

export function apply(ctx: Context) {
  ctx.on('agent/created', agent => {
    ctx.temporaryMessages.push(agent.session, {
      text: '你有一条来自 Alice 的新消息，请按需查看。',
      ttlTokens: 0,
    })
  })
}
```

接口直接接收 `Session`。在自己的消息渠道回调中调用同样的方法即可；`push()` 只排队，等待会话下一步推理，不主动唤醒空闲 Agent。

```ts
const id = ctx.temporaryMessages.push(agent.session, {
  text: '当前剩余预算：12 元。',
  ttlTokens: 2000,
  key: 'budget',
})

// 同一会话里再次发送相同 key，会替换尚未消费或仍然有效的旧消息。
// 撤回也在下一次准备步骤生效。
ctx.temporaryMessages.remove(agent.session, id)
```

| 参数 | 含义 |
| --- | --- |
| `text` | 直接发送的文字；接口消息不会被当作模板执行 |
| `ttlTokens: 0` | 用于一个推理步骤，下个步骤准备前撤下 |
| `ttlTokens: N` | 首次送达后，模型累计新生成 N 个 token 时过期 |
| `k: N` | 首次送达后累计 N 次 `agent/pre-step` 时过期；k=1 可用于一次推理，k=2 可用于两次 |
| `k: 0` | 只用于一次推理 |
| 只传一种限制 | 只启用这一项，不继承另一项的设置 |
| 同时传 `ttlTokens` 与 `k` | 任意一项先到期就删除；新消息的两个计数重新开始 |
| 两项均省略 | 按 0 处理，只用于一次推理；外部接口不继承页面模板的寿命 |
| 某一项为 `false` | 明确关闭这项限制；两项都显式为 false 时，保留到主动撤回或同 key 替换 |
| `key` | 可选，同一会话中同 key 的新消息替换旧消息 |
| `compressor` | 可选，单条消息专用的函数；省略时使用设置页当前选中的压缩器 |

正数寿命累计服务商报告的 **outputTokens**，不重复累计历史输入。包含哪些思考 token，以服务商输出计数为准；缺少 usage 时按内容字符数粗估。它是寿命计数，不是账单统计。

`k` 统计的是 `agent/pre-step` 事件，不是用户聊天轮数；同一轮中的工具循环也会计数。token 在工具执行前或下一次 pre-step 检查，k 在 pre-step 进入时计数，不会在模型生成中途插入或删除消息。两种计数都随日志恢复，移尾和压缩不会让计数倒退。

页面模板使用设置页中的寿命，到期后自动重新求值；外部 `push()` 的消息到期后直接删除，再次发送时开始新周期，不会自动重复发送。同一个步骤的网络重试会复用当前快照，不重复执行查询工具。

可以在单次调用中传入压缩函数：

```ts
ctx.temporaryMessages.push(agent.session, {
  text: '当前剩余预算：12 元。',
  ttlTokens: 500,
  k: 3,
  key: 'my-plugin/budget',
  compressor: async history => {
    // history 是整段可压缩历史的 JSON 字符串，包含角色、内容和消息 ID。
    const messages = JSON.parse(history)
    return messages // 原样保留结构，也可以筛选其中需要保留的原消息。
    // return '历史摘要：预算已检查，任务进行中。' // 返回字符串可自由生成摘要。
  },
})
```

这个函数不进入设置页注册表，可以同步返回，也可以返回 Promise。字符串恒等函数 `history => history` 会保留原结构；返回其他文字时，核心将其作为一条历史摘要写回原范围；返回空字符串或空数组会清空可处理部分。结构化返回目前支持按原顺序选择原消息；修改结构化消息内容或重排消息尚未实现，可用摘要字符串表达改写结果。

单次传入的函数只存在于当前会话对象的内存中，不会把函数源码或闭包写入日志。进程重启、会话重建或分叉后，如果原函数不在且结果尚未记录，旧消息到期时按「保留原文」处理。已记录写回计划时，直接补完保存的结果，不再调用原函数。需要恢复后持续可用的实现，应注册为插件服务并通过设置页选择。

## 压缩器

打开 **设置 → 临时消息 → 压缩器**，从下拉列表选择后点击「保存设置」，下一次清理就生效，不需要重载插件。列表的名称和说明来自宿主注册表，内置压缩器也使用同一注册接口。

| 选项 | 实现 | 效果 |
| --- | --- | --- |
| 保留原文（默认） | `async messages => messages` | 原样保留传入的消息 |
| 清空全部（测试用） | `async () => []` | 清空核心交入的全部内容 |

临时消息到期、被撤回或被替换时，截取它的原始位置之后、截至最近一次模型输出的内容。核心保留其中未配到结果的调用消息，其他临时消息也不交给压缩器。已注册的压缩器接收结构化 `Message[]`；单次传入的函数接收同一段内容的 JSON 字符串。

同一批删除中，使用同一个函数的范围从最早起点合并执行一次；不同函数按起点从后往前执行，较早范围会收到较晚范围的处理结果。全部函数成功后再写回日志。仍有效的临时消息保留，移到尾部时保留最初寿命和压缩起点。

所有消息使用统一的到期判断：启用的 token 或 k 上限任意一个先达到就过期。寿命为 **0** 时，压缩范围通常就是本次模型输出；更长寿命的范围会包含期间累积的输出、工具结果和用户输入。最近一次模型输出之后的新输入不在压缩范围内。

核心按压缩范围中的 call ID 与 toolCallId 配对。未配到结果的原始 assistant 调用消息暂不交给压缩器；同条消息中的文字、思考也随原消息保留。已完成的调用和结果一起交给压缩器，「清空全部」会把它们一起删掉。压缩器本身不判断工具调用状态，清空器始终只返回空数组。切回「保留原文」只影响之后的清理，不会重新放回已清除的上下文；原始日志始终保留。

压缩器注册表和内置实现位于 `src/compressors.ts`。没有单次压缩函数时，核心在每次清理时根据设置页保存的 ID 调用处理函数。返回原消息数组用于选择保留哪些消息；返回字符串用于写回摘要，摘要使用带来源标记的 user 消息，不伪造新的模型输出或用量。未闭合调用的保留规则在 `src/messages.ts` 核心中，对所有压缩器一致生效。

其他插件可以直接注册一个压缩器，无需修改设置页或配置类型：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-temporary-messages'

export const inject = ['temporaryMessageCompressors']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.temporaryMessageCompressors.register({
    id: 'my-plugin/keep-last',
    name: '保留最后一条',
    description: '仅保留传入范围中的最后一条消息。',
    compress: async messages => messages.slice(-1),
  }))
}
```

重新打开「压缩器」选项卡即可看到新条目。`id` 用于保存选择，`name` 和 `description` 用于页面展示，`compress` 接收消息数组并返回需要保留的原消息数组或摘要字符串。`register()` 返回撤销函数，由 `ctx.effect()` 在提供它的插件卸载时调用。注册表属于当前插件实例；重复 ID 会报错，已选压缩器不存在时也会明确报错，不会自动改用其他压缩器。

## 每一步发生什么

1. 在 `agent/pre-step` 累计步数。上一步已在工具执行前清理过时复用结果；若队列里的消息刚达到 k，或已被撤回、替换，则补做这次清理。
2. 清理时按统一的寿命、撤回和同 key 更新规则确定范围，等待当前压缩器返回并写回。未到期消息重新排队，保留最初的寿命与压缩起点。
3. 等待其他准备插件完成，把待发接口消息追加到本步消息批次末尾，记下本步模板。
4. 在 `llm/stream` 中，等本轮输入、模型和工具信息全部入日志后计算需要刷新的模板，再把新快照追加到 session；未到期时沿用现有快照。
5. 检查所有临时消息的位置，将它们移到 DSH 的运行状态或工具变更之后。
6. 从调整后的 session 重建请求，交回 `ctx.llm.stream()` 发送。原请求不发送，用对象标记跳过自己再次拦截，所以不会多调用一次模型。
7. 模型输出写入后，若发起工具调用，就在 `tools/pre-execute` 中提前清理，再执行工具、记录新结果。同一步多个工具只清理一次，模板和预览里的工具调用不触发清理。

队列和寿命信息随 session 日志保存，支持恢复和分叉。撤下采用官方 surface replacement：用不产生模型输入的空 system 消息替换旧节点。选择 system 是为了不被 DSH 当作工具变更记录。默认「保留原文」不会重写普通用户消息、工具结果或模型输出的日志节点。

**撤下的是模型上下文，原始日志仍保留原文。** 临时消息不会自动变成普通历史输入；但日志磁盘占用不会因此减少。停用整个插件后也就没有清理钩子了，若要撤下当前消息，可先在本插件设置中关闭开关，让会话完成下一次准备步骤。

**尾部位置：** 在 DSH 0.2.2-rc.1 的原生请求流程中，临时消息处于最终发送的消息内容末尾。调整会写入 session 的 surface 操作，日志恢复后的上下文与发送内容保持一致；重试时新增的运行状态也会排在临时消息前。本插件使用宿主事件和 Session 接口，不修改 DSH 核心，也不直接修改冻结的请求对象；元数据接口的限制见下方「中断与恢复」。如果另一个插件同样重写 `llm/stream` 的消息顺序，需要协调双方的执行次序。

移除旧消息、移动仍有效的临时消息会改变缓存前缀；具体缓存成本由模型服务商决定。内置的保留、清空两种压缩器不调用模型；外部提供的函数可以自行调用模型生成摘要。

## 中断与恢复

清理和移尾会先把完整写回计划记入日志，再执行表面上下文的替换，最后一次性提交队列和清理状态。每条写入带有确定的消息 ID；程序在任意两条记录之间退出后，插件下次处理该会话时按 ID 补完尚未完成的写入。恢复过程中再次退出也可继续，不重复执行已经记录结果的压缩函数。

压缩函数和模板求值支持取消等待。压缩函数可接收可选的第二个参数 `signal`，传给自身的异步查询。取消发生在计算结果期间时，不开始新的历史写回；忽略 signal 的函数稍后返回，其结果也不会继续改动历史。函数已经发出的外部请求或其他副作用不属于上下文回滚范围。

恢复能力以 DSH 实际保存下来的完整日志记录为边界。尚未落盘的模型输出、磁盘损坏、以及结果尚未记录前压缩函数已经发生的外部副作用，没有恰好一次保证。0.1.8 及更早版本产生的半次清理缺少写回计划，不会自动推测修复。未完成的计划需要本插件启用后才能补完。

兼容性限制：当前元数据使用 `@deepseek-ai/dsh-session` 的 `appendPluginRecord`。该版本 README 明确将它限定为仓库内实验代码使用，不供外部插件调用。0.2.2-rc.1 上的运行与恢复已实测，但这仍是正式发布前需要解决的接口兼容性问题；本次没有修改 DSH 核心，也没有因文档限制另加一套持久化实现。

## 读代码

建议从这几个文件开始：

| 文件 | 负责什么 |
| --- | --- |
| `src/index.ts` | 配置、事件钩子，把流程串起来 |
| `src/messages.ts` | 排队、寿命、同 key 更新、撤回、日志恢复 |
| `src/compressors.ts` | 压缩器注册表、接口和内置实现 |
| `src/cancellation.ts` | 取消异步等待，丢弃迟到结果 |
| `src/template.ts` | 识别表达式、执行、拼成文字 |
| `src/tools.ts` | 把 `tool()` 接到 DSH 的工具执行流程 |
| `src/client/settings.tsx` | 设置页 |
| `src/controller.ts` / `src/remote-contract.ts` | 设置页与宿主之间的两个接口 |

代码使用普通函数、消息队列与注册表类和少量中文注释。没有重试框架、兼容层或自造表达式语言；模板错误直接报告，不会悄悄使用旧状态。

## 本地开发

```powershell
git clone https://github.com/kazari-qwp/dsh-temporary-messages.git
cd dsh-temporary-messages
npm ci
npm run check
npm pack
```

`npm run check` 做 TypeScript 检查、自动测试和打包。`dist/index.js` 是宿主入口，`dist/client/index.js` 是 DSH 浏览器 loader 使用的客户端入口。

本机有 Microsoft Edge 时，可以额外运行：

```powershell
npm run test:ui
```

自动测试包括：真实 AgentLoop 的两轮输入、一次性清理、正数寿命、队列恢复、同 key 更新、请求重试、并发会话、发送前的运行状态和工具变更、日志重建与最终请求一致、PTC 模式工具调用、工具策略拒绝，以及官方 Client Remote → Host Gateway 通信。设置页使用真实 DSH 插槽、Remote 服务和 Cordis 依赖检查做命令行渲染测试。这些测试使用模拟模型，不产生 API 费用。

可选浏览器测试检查打包后的工具插入、预览、保存和窄窗口布局。

0.1.2 实现发送前的尾部调整。2026-11-08 另用桌面版的官方账户适配器调用了两次真实 `deepseek-flash`，关闭思考，每次输出上限 64 token。检查实际 HTTP 请求后确认：临时消息位于最后一个内容块，第二轮旧快照及一次性消息已移除，新工具正常保留。实际共消耗输入 433 token、输出 2 token；短测试未命中缓存，不能用它推算长对话的缓存节省。

0.1.1 修复了设置页遗漏 Remote 命名空间依赖导致的空白页，并加入使用真实 DSH 插槽、Remote 服务和 Cordis 依赖检查的命令行渲染测试。

0.1.3 开放 `ctx`、`agent`、完整 `session`、`modelSelection`、`signal`，并把模板求值移到最终发送前，使状态查询能看到本轮输入和工具信息。重试仍复用快照。17 项自动测试通过；另用官方账户服务、TokenMeter 和真实模型验证了余额模板的两轮尾部输出与旧消息清理。

0.1.4 增加压缩器选项卡和异步清理链路，保存选择后下一步生效。21 项自动测试通过，包括批量删除边界、等待压缩器、正数寿命移尾、工具调用与结果一起清除、日志恢复和设置页保存。另用真实 `deepseek-flash` 连续调用四次，检查实际 HTTP 请求，验证清空、保留、再切回清空均无需重载，临时消息始终位于尾部。此次用量为未命中输入 682 token、缓存读取 128 token、输出 4 token。

0.1.5 将清理提前到工具执行前，下一次 pre-step 跳过已完成的清理；没有工具调用时仍在 pre-step 清理。所有寿命使用同一规则，并保留长寿命消息的原始压缩起点。清空压缩器按原样保留调用消息与工具结果。23 项自动测试通过。真实测试先确认删除调用会被本机 DeepSeek 适配器拒绝（`DeepSeek Messages tool result has no matching call`）；保留调用后，清空模式与保留模式都完成了工具调用、结果读取的两次请求。

0.1.6 将未闭合调用的保留移入核心。压缩器只接收可处理的历史，清空器恢复为 `async () => []`，已完成的调用和结果一起清除。25 项自动测试通过。另用真实模型连续调用三次、分两步执行工具：寿命为 40 token，前两步各生成 39 token，第二次工具执行前删除旧调用及结果、保留新调用，第三次请求成功读到新结果。此次用量为未命中输入 750 token、缓存读取 512 token、输出 81 token。

0.1.7 将压缩器选择改为注册机制。内置和外部压缩器共用注册表，设置页按注册信息生成下拉选项，配置保存压缩器 ID。26 项自动测试通过，包括外部插件注册与卸载、官方 Remote 传递目录、设置页动态显示并保存新选项，以及真实 AgentLoop 按注册实现处理上下文。

0.1.8 增加单条消息的压缩函数和 k 限制。外部调用的两个限制均省略时为一次性；页面模板按设置的 token/k 上限刷新。支持将摘要写回上下文，并从后向前处理不同压缩器的重叠范围。35 项自动测试通过。真实 API 连续三次请求、两次工具调用验证了 k=2 到期后，单次压缩函数只接收已完成的旧调用与结果，写回摘要后，新调用及其结果仍正常被模型读取。此次用量为 inputTokens 628、cacheReadTokens 640、outputTokens 81。

0.1.9 根据故障注入结果修复中断恢复。旧版 18 个日志截断点中有 8 个恢复错误；新增写回计划后，23 个截断点及恢复中的再次截断均通过。另修复失败的清理 Promise 阻塞后续对话、取消等待无响应及迟到压缩结果修改历史、等待期间新消息被旧消息覆盖或撤回失效。46 项自动测试通过，包含四种写入场景的独立子进程强杀与实际落盘日志恢复。没有针对未复现的问题增加处理分支。

## 对照的官方接口

- [Agent 事件与准备流程](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md)
- [Session 与模型上下文](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md)
- [工具执行](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)
- [设置页](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings/README.md)
- [设置页通信](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/gateway/README.md)
- [插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)
