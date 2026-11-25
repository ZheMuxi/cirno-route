# Pi 榜单评分与选模

Pi 使用本地 Gemma 4 E4B 判断任务所需的能力和硬性要求，随后用本地快照计算十分制能力分。首次升级在仓库根目录运行 `uv sync --frozen`，在 Pi 执行 `/reload`。Parquet 读取依赖只在同步进程中加载。

| Pi 命令 | 作用 |
| --- | --- |
| `/bakamodels` | 查看各榜版本、原始记录数、上次检查时间、失败原因和本地价格覆盖 |
| `/bakamodels refresh` | 立即检查 Arena Text、Arena WebDev 和 Epoch AI |
| `/bakamodels import livebench 文件路径` | 导入 LiveBench 2.0 官方快照。其他两个来源名为 `superclue`、`decathlon` |
| `/bakamodels prices` | 单独刷新官方 API 参考价格 |
| `/classify 任务` | 查看各候选的分项、原始成绩、来源和价格推荐 |
| `/bakarouter` | 对下一条及后续普通输入实际选模 |
| `/superbakarouter` | 用同一评分接口为统筹和各个工作包选模 |

## 数据来自哪里

- **Arena** 使用 Hugging Face 官方数据集里的 `text/latest` 和 `webdev/latest`。每次同步先锁定同一个仓库提交，再读取完整的 Parquet 分片。记录保留原始标签、子榜、发布日期、票数与 rating。WebDev 区分总体、React、HTML 和从图像实现网页。[Arena 官方数据集](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset)
- **Epoch AI** 读取官方 ZIP 中的七项原始 `mean_score`，包括 MATH Level 5、OTIS Mock AIME、FrontierMath Tiers 1–3 v2、GPQA Diamond、SWE-bench Verified、MirrorCode 和 SimpleQA Verified。记录保留具体模型版本、推理档位、运行 ID、时间和可用的日志链接。数据版本取 ZIP 内容的 SHA-256 前缀。[Epoch AI 官方数据包](https://epoch.ai/data/benchmark_data.zip)
- **LiveBench 2.0、SuperCLUE、AI 十项全能** 在首次成功导入后参与选模。官方总榜和任务分项都可导入。来源链接和原始评测归属随成绩一起保存。同步、导入和补查均排除 Artificial Analysis 及其转载。[LiveBench](https://livebench.ai/) · [SuperCLUE](https://www.superclueai.com/) · [AI 十项全能](https://octathlon.wendystars.com/decathlon/categories/)

启动时在后台检查距今满 24 小时的自动来源。有有效快照时，分类直接读取本地数据。首次完全没有快照时，当前分类会等待已经启动的首次同步。各来源独立校验并在 SQLite 事务中替换，保留最近两份有效数据。一次下载或导入失败，会记录失败原因并继续使用可读的上一份。数据保存在仓库的 `.runtime/leaderboards/`。

## 十分制怎样计算

1. Gemma 给出主能力、可选次能力以及工具、联网、视觉、长上下文和结构化输出要求。程序先筛除不符合文件保护、Pi 可用范围或硬性要求的候选。注册信息和有出处的模型配置可证实硬性能力，仍待证实的能力只做定向查询。
2. 程序为任务选取分项。例如 React 组件选 WebDev React，常规计算选 Epoch MATH Level 5，复杂数学可参考 FrontierMath 或 OTIS。通用写作与指令遵循分别使用对应的 Arena Text 子榜。具体发行版、量化版、推理档位和特殊运行环境分别匹配。
3. 每个分项使用评分规则 `task-percentiles-v1` 内固定的参考模型及档位。把同口径的参照原始成绩排序，最低和最高分别映射到 0 和 10，中间参考点等距，同值取平均名次，候选在相邻点间线性插值。例如参照成绩为 1000、1100、1200、1300 时，1150 对应 **5.0/10**。超出两端的分数截在 0 或 10。参考组缺人或成绩全部相同时，该分项保留未知。
4. 同一评测只贡献一次。重复的 Epoch 运行取最近一次，有冲突且没有记录可区分的 Arena 标签保留未知。同维度的独立分项等权。单能力占 100%，双能力按 70% 和 30% 加权，最后保留一位小数。
5. 部分分项未知时，展示已测部分的平均分、缺失分项和加权覆盖率。例如数学证明选中两个分项、只有一项有成绩，数学覆盖率为 50%，只补查另一项。任务分在有数据的权重上归一化。实际推荐先取硬性要求满足、覆盖最完整的一组。仅有厂商功能说明时显示「资料推定」，作为候补，能力分保持未知。分数表示在固定参照组中的相对位置，成功率需要另行测量。

三档价格偏好在可比候选中生效。「希望便宜」在距最高分 2.0 分以内选已知低价。「均衡」只在差距不超过 0.5 分且能节省超过三分之二时让价差改变选择。「接受昂贵」优先任务能力，同分时选已知价格较高的模型。缺价只影响价格比较。习惯推荐在切换前也会复核本轮榜单、能力和价格；相同输入在同一进程可复用 Gemma 的任务标签。

## 何时会用 DeepSeek Search

| 查榜情况 | 处理 |
| --- | --- |
| 所需能力均有可比成绩，相关榜读取正常 | 直接本地计算 |
| 型号已出现，但当前所需分项、档位或参照不齐 | 只查这次需要的缺项 |
| 所有启用的榜都读成功且无此具体型号 | 按具体型号查公开评测和厂商资料 |
| 有相关榜读取失败 | 记录失败来源并查询受影响的型号或分项，保留已有实测 |

补查复用项目的 DeepSeek Search 和研究模型配置。外发内容限于公开型号、能力标签和评测口径。程序核验结果出处、原文、型号、数值和可比口径。已存在的同次实测优先。文件正文、用户原文、Pi 会话和价格都不会进入能力查询。同一型号、档位及缺项的并发请求会合并。有效结果、无结果及临时错误分别按能力研究的有效期、未知结果有效期、故障重试间隔缓存。

## 导入官方快照

把官方快照的 CSV 或 JSON 表和一个说明文件放在同一目录。下面以 LiveBench 的总榜和编程两列为例。将日期、环境、单位和列名改为官方表的真实值。导入其他来源时，把来源名、链接和分项替换成相应榜单的值。

```json
{
  "source": "livebench",
  "version": "官方发布批次",
  "source_url": "https://livebench.ai/",
  "table": {
    "file": "table.csv",
    "model_column": "Model",
    "columns": {"overall": "Overall", "coding": "Coding"},
    "environment": "官方快照注明的评测环境",
    "unit": "percent"
  }
}
```

执行 `/bakamodels import livebench ./说明.json`。相对路径从当前 Pi 工作目录解析。JSON 表支持用 `rows_path` 指向记录数组，例如 `["data","rows"]`。如原表分别记录档位或环境，可指定 `effort_column`、`environment_column`。分数越低越好时设置 `"direction":"lower"`。也可在说明文件直接提供 `rows` 数组，每条包含 `section, model, score, unit, metric, environment` 和可选的 `effort`。

导入分项使用固定参照组。官方表与内置参照不重合时，可在说明文件提供 `reference_groups`，例如 `{"math":{"version":"math-panel-v1","models":["确切型号 A","确切型号 B","确切型号 C"]}}`。参照至少三个，同一组版本的成员固定，换成员必须更换组版本。没有完整参照时仍保留原始成绩。

- LiveBench 2.0 的七个任务类别对应 `agentic, reasoning, coding, browser_use, data_analysis, research, design`，总榜用 `overall`。[LiveBench 官方榜单](https://livebench.ai/)
- SuperCLUE 支持中文综合、数学、科学推理、代码生成、任务规划、精确指令遵循和幻觉控制等栏目。对应键包括 `overall, math, science_reasoning, coding, task_planning, instruction_following, hallucination_control`。[SuperCLUE 官方说明](https://www.cluebenchmarks.com/superclue_2025)
- AI 十项全能的数学推理、性能优化、算法对抗、空间推理、几何建模、复杂交互应用、游戏开发、物理模拟、视觉渲染与系统架构，对应 `math, optimization, algorithm_contest, spatial, geometry, webdev, game_ai, physics, rendering, systems`。运行环境可以记录参测智能体及其版本。[官方评测仓库](https://github.com/Wendystar0628/AI-All-Round-Bench)

同一类别还可导入具体子任务，格式为 `类别/子任务`，例如 `coding/debugging`。当任务选中更细的成绩时，上一级类别与同源总分会跳过，避免重复计分。

网关别名可在 `config/pi-classifier.json` 的 `leaderboards.models` 中按完整 `provider/model` 配置 `canonical`、说明该映射的官方 `source_url`，以及同时列出网关标识和具体型号的逐字引文 `identity_quote`。可指定评测环境 `environment` 或已有官方依据的 `hard` 布尔能力。映射只对该条目生效。
