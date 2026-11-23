"""Opt-in task labels produced by Gemma in the same scoring completion."""

import json
from importlib.resources import files
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .contracts import Contract

TAXONOMY = json.loads(files("cirno_route").joinpath("resources/task-profile-v1.json").read_text())
INPUT_STATUSES = ("ready", "missing", "unclear")
INPUT_INSTRUCTION = """
输出对象第一项必须是 input_status，只判断本次 task.text 和 task.requirements：
ready：任务意图明确，所需材料已经提供，或任务本身不需要给定材料。
missing：要求处理某份具体材料，但正文、代码、附件内容或必要上下文没有提供。
unclear：不知道具体要交付什么，或仅有依赖未提供前文的指代。
候选能力资料不是用户待处理的材料，不能补足任务输入。
先判断输入，再给候选分。missing/unclear 时所有候选质量分为 null，不改做通用建议。
要求翻译、总结、修复“下面/附件/刚才”的材料但没有材料，是 missing；
“继续修改它”而不知道修改对象，是 unclear；原创、通用方法、示例代码无需先提供原材料。
完整的工具/检索任务可以 ready，例如“搜索今天的天气”；不能因结果尚未查询就判 missing。
有明确可读取的文件路径/URL并要求读取可判 ready；仅提“附件/前文”但未提供内容或来源才缺材料。
ready 只表示输入就绪，不证明候选支持任务；联网/工具等关键能力没有证据时，该候选仍须 null。
""".strip()
INSTRUCTION = (
    """
本次在候选评分之后额外输出 task_profile，和候选评分在同一个 JSON 对象中，不增加推理轮次。
task_profile 只由任务正文决定，与候选名称、数量、顺序、价格和历史偏好无关。
kind 必须选择下列固定类型；按实际交付操作而非材料主题分类。
"""
    + json.dumps(TAXONOMY["kinds"], ensure_ascii=False)
    + """
difficulty: routine 表示范围清楚的常规单项任务；complex 表示多约束、跨模块、
复杂证明或系统设计；不能可靠判断时 unknown，不因用户写“复杂”就判复杂。
requirements 是五个必填布尔字段。逐项独立判断本轮用户实际要求，true 表示必需，false 表示不需要。
tools：完成交付是否必须实际读取/写入文件、运行终端程序或调用工具？
structured_output：最终回复本身是否必须整体为可解析的 JSON、CSV、XML 等指定机器格式？
web：是否必须实际查询互联网或读取网址内容？
vision：是否必须处理图片内容？long_context：是否明确需要处理超长材料？
只看 task.text 与 task.requirements，不看本分类器的 JSON 协议或候选资料。
未要求的项目为 false；每项都要判断，允许 tools 和 structured_output 同时为 true。
读取路径里的文件再总结，需要 tools=true，即使主要交付是总结；正文已经给出则不需读取工具。
仅编写代码、介绍命令、讨论工具，不等于执行。用户明确不运行/不读写文件时 tools=false。
程序内部解析或返回 JSON、介绍 JSON、给 JSON 示例并解释，不等于最终回复必须为机器格式。
只给代码/译文/数字，structured_output=false；不要 JSON 或改用自然语言时也为 false。
例：Read ./README.md and summarize it => tools=true, structured_output=false。
例：What is 2+2? Respond only as a JSON object => tools=false, structured_output=true。
例：执行测试，并且只返回严格JSON结果 => tools=true, structured_output=true。
例：写一个返回JSON的函数，只给代码，不运行 => tools=false, structured_output=false。
例：解释如何运行测试，不实际执行，只用自然语言 => tools=false, structured_output=false。
格式、工具等约束不构成第二个并重任务；解释概念并仅用JSON回答仍是 qa，不是 mixed。
task_profile 不表达用户偏好，也不改变评分；不能因为需要记忆而强行选择类型。
"""
)


class RequirementChecks(Contract):
    """Generation-only checklist; each requirement is an explicit independent decision."""

    tools: bool
    structured_output: bool
    web: bool
    vision: bool
    long_context: bool


class TaskLabels(Contract):
    kind: str
    difficulty: Literal["routine", "complex", "unknown"]
    requirements: list[str] = Field(max_length=5)

    @field_validator("kind")
    @classmethod
    def valid_kind(cls, value):
        if value not in TAXONOMY["kinds"]:
            raise ValueError("unknown task kind")
        return value

    @field_validator("requirements")
    @classmethod
    def valid_requirements(cls, value):
        if len(set(value)) != len(value) or any(v not in TAXONOMY["requirements"] for v in value):
            raise ValueError("invalid requirements")
        return sorted(value)

    @classmethod
    def from_wire(cls, value):
        if isinstance(value, dict):
            items = value.get("requirements")
            if isinstance(items, dict):
                checks = RequirementChecks.model_validate(items)
                value = {
                    **value,
                    "requirements": [
                        name for name, required in checks.model_dump().items() if required
                    ],
                }
            elif isinstance(items, list) and all(isinstance(item, str) for item in items):
                # Retain legacy parsing without changing the strict public/storage contract.
                value = {**value, "requirements": list(dict.fromkeys(items))}
        return cls.model_validate(value)

    def public_profile(self, input_status: str):
        return TaskProfile(
            kind=self.kind,
            difficulty=self.difficulty,
            requirements=self.requirements,
            reusable=input_status == "ready"
            and self.kind not in {"mixed", "unknown"}
            and self.difficulty != "unknown",
        )


class TaskProfile(TaskLabels):
    """Stable public/storage shape; reuse is derived from the separate model input verdict."""

    reusable: bool

    @model_validator(mode="after")
    def known(self):
        if self.reusable and (self.kind in {"mixed", "unknown"} or self.difficulty == "unknown"):
            raise ValueError("unknown profile cannot be reused")
        return self


def profile_schema():
    schema = TaskLabels.model_json_schema()
    schema["properties"]["kind"]["enum"] = list(TAXONOMY["kinds"])
    schema["properties"]["requirements"] = RequirementChecks.model_json_schema()
    return schema
