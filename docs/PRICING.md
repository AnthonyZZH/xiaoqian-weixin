# CNY 价卡与计费边界

2026-11-02T04:56:39Z 官方观察快照已对应到部署记录，模型单价没有变化。本次替换的是旧的内部两天 TTL 和过期说明；不更改生产开关、不新增付费调用、不启用自动轮换。来源：[官方模型价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[Search/Fetch 计费规则](https://api-docs.deepseek.com/zh-cn/guides/search/)。

## 模型与网页工具分项核算

下表为该次观察到的人民币价格，单位为元/百万 tokens：

| 模型 | 时段 | 输入缓存命中 | 输入缓存未命中 | 输出 |
|---|---|---:|---:|---:|
| deepseek-flash | 空闲 | 0.02 | 1 | 4 |
| deepseek-flash | 高峰 | 0.04 | 2 | 8 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |
| deepseek-v4-pro | 高峰 | 0.30 | 9 | 27 |

高峰为北京时间周一至周五且不含中国法定节假日的 09:00–12:00、14:00–18:00，其余为空闲。缺少日历/时段证据时传入 unknown，保留空闲到高峰区间，不自行猜测。

模型核算使用已归属到同次请求、路由和价卡的数字 usage。缓存命中、未命中和输出分桶；推理 tokens 已在输出中，不能重复相加。相同 attempt 去重，冲突记录拒绝；没有明确 cache-write 单价时，非零 write bucket 拒绝估算。未核对币种或别名不自动套价。

Search 和 Fetch 各为每次可计费成功请求 0.005 元。只有 HTTP 200 且有结果才计入：Search 结果非空，Fetch 有网页正文。失败、空结果和超时不计；返回条数不增加一次请求的单价。Server 端工具此前的免费期于北京时间 2026-11-01 00:00 结束；该历史规则不能套给直接 API。网页工具调用费与模型 token 费用分开记录；若结果进入后续模型输入，按那次实际 token usage 计费，不再把估算正文长度重复加一笔。

本地 main 库 MCP 的文本搜索/读取不属于 DeepSeek Search/Fetch API，不能按这些操作次数扣网页 API 费。本地部署若另行启用外部 embedding/reranker 等服务，应单独核对，不能沿用“本地主库”名称推断零费用。

## 内部复核策略不等于官方有效期

当前页面没有声明模型价卡的官方开始/到期日：`official_effective_from`、`official_valid_until` 均为 null。`effective_from` 记录“本次观察到报价”的时间，并明确标注非官方起始日；早于观察时刻的模型请求不能倒套该快照。

`review_due_at` 是观察后一天的复核提示，不会在一天后自动判作报价失效。`local_review_deadline` 是观察后七天的最大未复核窗口；到点返回 `QUOTE_LOCAL_REVIEW_OVERDUE`，仅让价卡未知的轮换判断跳过。七天是项目内部控制，既不是官方保证，也不表示七天内价格不会改变。模型、币种、规则或官方页面内容变化都应立即重新核对；失败/含糊的核对不得刷新观察时间。本代码不自动联网更新。

观察器当前按上下文数值版本与 UTC 小时缓存诊断，缓存键不含价卡版本；仅替换价卡后，显示可能保留旧结果，直到下一次数值版本或小时变化。执行入口在两处经济判断重新调用计算器，不以旧显示结果授予执行许可。本次不修改缓存、模拟活动或强制刷新观察器。

## 测试与验收边界

通用源码中的 9 项价卡测试，以及新增 5 项只读集成测试已独立通过。覆盖精确 Decimal 单价、unknown 时段区间、每天提示/七天截止、不可倒填观察日、篡改拒绝、Server/direct API 历史区别、输入/缓存/输出去重、未知 write 费用，以及实际 numeric consumer 的相等/更贵/重叠三种 shadow 判断。测试使用合成数字，无真实 usage、聊天、人格、图片或演练数据。

```powershell
python -B -m unittest discover -s src/rotation-observer/calculator -p 'test_pricing*.py'
node --test src/rotation-observer/calculator.test.mjs src/rotation-observer/public-numeric.test.mjs
```

本次 14 项 Python 检查通过；两份 Node 测试已同步观察时间/内部截止语义并做语法检查，其完整 Node 套件、远端 CI 和服务器 SDK 测试未重跑。刷新价卡不证明真实摘要/切换验收，自动轮换仍为 OFF；文件自动接收仍为候选，新图片自然识别仍待验收。

组件来源与文件哈希见 [来源清单](PRICING-SOURCE.json)。前次检索/轮换清单属于它记录的历史提交，本次清单仅覆盖价卡增量，不宣称整仓库与生产完全一致。
