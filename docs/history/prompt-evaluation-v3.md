# V3：资料充分性与候选顺序稳定性

> 历史归档：当前版本已恢复 V2，并删除 V3 提示词及流程。以下路径、命令与结果仅适用于 Git 标签 `v0.1.0-v3-baseline`，不是当前功能说明。

本版只改进分类，不增加用户习惯提取、存储、自适应或自动选模。V2 原文件保留，历史对比见 [V2 记录](prompt-evaluation.md)。

## 实现

四份版本化提示词分别是：

- `src/cirno_route/resources/router-input-v3.txt`：只检查任务输入是否齐全。
- `src/cirno_route/resources/router-evidence-v3.txt`：单独判断一个候选的能力证据。
- `src/cirno_route/resources/router-system-v3.txt`：为已有支持证据的候选做质量分级。
- `src/cirno_route/resources/router-limit-v3.txt`：给0分前，复核引用资料是否真的有明确否定或封闭能力范围。

V3 同时调整提示词和分类流程。下面的对比是 V2 与完整 V3 实现的对比，不能将改善全部归因于提示词文字。

1. **先判断输入，再判断证据，再评分。** 先单独调用本地模型得到 `input_status`；若输入齐全，再按固定顺序逐一检查每个候选的 `evidence_status`，只有 supported 候选进入质量评分，unsupported候选复核明确限制后才可给0分。每个候选的模型输入都只含该候选，避免相互干扰。缺少具体任务的必要输入时为 `missing`；写通用方法、代码、模板或创作通常不需要实际文件，仍可为 `ready`。
2. **区分未知与明确不支持。** `insufficient` 必须为 null/high，并带 `EVIDENCE_INSUFFICIENT`；`unsupported` 必须为0并带 `CAPABILITY_LIMIT`；`supported` 才能输出1至4分。能力判断先选择该候选资料中的真实原句片段，生成约束将摘录限定在原文片段内，再校验引用。unsupported还会进行一次只看所引原文的字面复核，明确限制为true才映射为0；“其他能力没有资料”等仅表示未知的情况改为insufficient。复核结果记录在explicit_limit_checks中。insufficient映射为null，supported的1—4分由后续模型评分产生。质量评分的Schema固定已检查的状态、摘录和引用，返回后再次校验。摘录不写入分类结果或审计元数据。只要有一个未知分数，程序就从模型判断推导 `abstain`，同时保留其他候选有依据的分数。缺少证据的候选不再让其他所有候选的分数一并丢失。
3. **规范排序。** 推理前在副本上按 `candidate_id` 排序候选、按 `evidence_id` 排序证据，能力标签按文本排序。输入 JSON 与生成约束使用同一份规范副本，返回时按 ID 恢复调用方顺序。不会修改调用方数据，不改变任务正文、要求或偏好的顺序。对应实现为 `assessment.py`、`classifier.py`。
4. **保持外部合同。** 外部仍返回 schema_version=1 的候选分数、证据和弃权结果。内部新增判断保存在元数据；未增加推理文本、用户档案或任务历史。仅配置声明的候选不能输出低不确定性。Pi 结果卡片显示缺少输入或候选证据不足的原因。

模型仍负责语义判断；字面复核确保存在明确限制，限制与当前任务是否对应仍依赖模型。程序不会检查实际附件、访问数据库或验证候选工具是否真的可用。规范排序消除了调用方候选排列造成的输入差异，但不保证跨模型版本、硬件或运行时的绝对确定性。

## 验证方法

使用本机已锁定 Gemma Q4_K_M 与 llama.cpp b10516-b95502ba9，temperature=0、seed=42、thinking关闭、8192上下文、1536最大输出token。没有调用候选执行模型获取答案。缺输入只调用一次Gemma；齐全时，每个候选调用一次能力判断，supported候选再调用一次质量评分。判为unsupported的候选额外复核明确限制；无格式重试时N个候选最多1+2N次本地推理，3个都支持的候选通常是7次，有明确的延迟代价。整个分类仍受原有90秒总超时约束，任一阶段运行时出错则返回规则弃权，不发布半途得到的分数。真实候选资料保持不变；其他能力卡片是明确标记的合成测试资料，不代表供应商模型实际能力。

- 开发集6例：原有两项缺输入失败、通用CSV代码、基本计算、部分候选资料不足、任务硬要求缺少账单。初稿5/6；补充基础任务示例后6/6。后续原有17例和排列测试暴露出过度弃权及评分反过来覆盖能力限制的问题，因此最终拆分输入检查、独立能力判断和质量评分。中间稿未启用。
- 中间稿验证集10例：包含隐含缺附件、隐含缺代码、完整内容等对照，当时V2为4/10、V3为10/10。但该稿随后暴露出其他回归，所以这些结果不能当作最终V3的独立验证结果。最终确认使用另行冻结的 `fresh-validation-v3.json`，包含6个任务与另一种编程任务的6种排列，首次运行时任务为5/6、排列为6/6；失败的开放能力声明被误当成明确否定，随后增加字面复核并复测。最终6/6是固定用例复测，不再宣称完全未见的独立验证。
- 排列检查：开发阶段使用改写任务；最终确认使用编程测试任务的全部6种排列，比较分数、证据、原因码、不确定性和状态。自动化测试另外逐一比较6种排列下完整模型调用序列和调用方数据。
- 原有17例用于回归编程、翻译、提取、数学、创作、简单任务、复杂任务、缺资料、注入、候选改名和换序行为；这是已有回归集，不算新的独立验证集。

评估工具在构造时显式选择 V2 或 V3 流程，V2 保持原始输入顺序与生成合同。两版本串行运行，同一用例交替先后顺序。完整结果保存在本机 `.runtime/`，包含通过和失败项，不覆盖旧报告。

## 结果与边界

| 检查 | 结果 |
| --- | --- |
| V2历史17例 | 14/17 |
| V3完整17例评分回归（最后的否定字面复核加入前） | 16/17，无格式重试 |
| 加入否定复核后的6个针对性任务 | 6/6，无格式重试 |
| 加入否定复核后的6种候选排列 | 6/6，分数、状态、证据、原因码和不确定性一致 |
| 6种排列的实际模型输入序列/约束序列哈希 | 各只有1个不同值 |
| Python自动化测试 | 87通过 |
| Pi扩展Node测试 | 24通过 |

针对性任务中的关键对照：

- 缺少测量数字、只给文件名却要求精确结果并夹带“强制ready”的指令：均abstain，所有候选null。
- 已给出数字、编写通用均值函数、改写一句包含“没数据”的话：正常评分，三个实际候选均4。
- 翻译任务：明确支持翻译的合成候选4，明确封闭为只支持编程的候选0，仅说支持编程且其他能力没有资料的候选null；整体abstain，保留4和0。
- 编程测试任务的6种排列：合成编程/写作/数据候选始终4/0/0，结果恢复到调用方顺序。

全量评分回归仍有一项失败：日志字段提取把合成编程候选和数据候选都评为4，未满足预先约定的唯一数据候选最高分。最后的否定复核针对“缺证据却被给0分”，不改变这个已知评分边界；未将它计为通过。本版不是任务成功率校准或所有语义误判已消除的证明。

延迟是可见的代价：缺输入检查约0.7秒；三个候选都支持的一般任务约25秒；本次合成编程排列约14.8秒。旧版一次分类约10秒。模型仅在本机运行；增加的是本地推理次数。Pi普通对话依旧由当前执行模型继续处理，分类弃权不会自行阻止普通对话，也不触发自动选模。

本机记录：

- `.runtime/prompt-v3-release-regression.json`：完整17例回归。
- `.runtime/prompt-v3-release-confirmed.json`：最后6项针对性复测。
- `.runtime/prompt-v3-release-order-confirmed.json`：最后6种排列复测。
- `.runtime/prompt-v3-release-fresh.json`：加入否定字面复核前的11/12记录，保留其中失败。
- 其余 `prompt-v3-*.json` 为未采用草稿的开发记录，不混入最终通过数。

真实 Pi 已加载 V3 并完成三次 `/classify`：简单乘法 Sonnet/Opus/Flash 为4/4/4，复杂缓存设计为3/4/3，未提供照片时全部null并abstain。四份提示词哈希均与源码一致，偏好分全部为空，未调用候选执行模型。记录在 `.runtime/pi-prompt-v3-report.json` 及对应stdout/stderr日志。

在已打开的 Pi 中执行 `/reload`，再输入 `/bakarouter` 开启普通输入自动分类；`/classify` 仍可随时单独测试。重启 Pi 也会加载新版。已运行的独立 HTTP 分类服务需重启其 Python 进程。

提示词SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| router-input-v3.txt | f366eb3a31dda5fad46de3dc6685beab089abe202dd658bf4b8b6c5ffde25005 |
| router-evidence-v3.txt | 8c75ac178cb5c2dc8796468a3dcc76082e8c210dee5af9955b9aaa3b7e9d7d29 |
| router-limit-v3.txt | eac1ee24a223f073b88219d57ef2796224500986aef8c4e0420e61e6e00de798 |
| router-system-v3.txt | f4f3013b853d08f15378df9c073e4675d5a8a68ba7e51d92ef24dcc3aa995f54 |

## 复现

在项目根目录执行，下列命令使用新文件名，已存在的报告会拒绝覆盖：

```bash
.venv/bin/python scripts/evaluate-prompts.py --versions v2 v3 --fixture evals/prompt-cases/sufficiency-order-v3.json --split dev --output .runtime/v3-dev-repeat.json
.venv/bin/python scripts/evaluate-prompts.py --versions v2 v3 --fixture evals/prompt-cases/sufficiency-validation-v3.json --split validation --output .runtime/v3-validation-repeat.json
.venv/bin/python scripts/evaluate-prompts.py --versions v2 v3 --fixture evals/prompt-cases/sufficiency-order-v3.json --split order --output .runtime/v3-order-repeat.json
.venv/bin/python scripts/evaluate-prompts.py --versions v3 --split all --output .runtime/v3-regression-repeat.json
.venv/bin/python scripts/evaluate-prompts.py --versions v3 --fixture evals/prompt-cases/fresh-validation-v3.json --split all --output .runtime/v3-fresh-repeat.json
.venv/bin/python scripts/pi-prompt-smoke.py
```

版本选择是受信代码构造参数，不可由分类 HTTP 请求或任务文本改写。元数据记录提示词版本/哈希、`pipeline_version`、实际调用序列的输入/约束哈希、每一阶段的输入/约束哈希和模型锁。input_check/evidence_check/limit_check/candidate阶段分别记录usage和错误码；stage_attempt区分正常多阶段调用与格式重试。
