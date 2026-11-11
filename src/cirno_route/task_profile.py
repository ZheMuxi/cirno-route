"""Opt-in task labels produced by Gemma in the same scoring completion."""

import json
from importlib.resources import files
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .contracts import Contract

TAXONOMY = json.loads(files("cirno_route").joinpath("resources/task-profile-v1.json").read_text())
INSTRUCTION = (
    """
本次额外输出 task_profile，和候选评分在同一个 JSON 对象中，不增加推理轮次。
task_profile 只由任务正文决定，与候选名称、数量、顺序、价格和历史偏好无关。
kind 必须选择下列固定类型；按实际交付操作而非材料主题分类。
"""
    + json.dumps(TAXONOMY, ensure_ascii=False)
    + """
difficulty: routine 表示范围清楚的常规单项任务；complex 表示多约束、跨模块、
复杂证明或系统设计；不能可靠判断时 unknown，不因用户写“复杂”就判复杂。
requirements 仅列出明确且必需的工具操作、联网、视觉、长上下文或严格结构化输出，
普通代码输出不等于 structured_output，纯文字讨论工具不等于 tools。
特别注意：只检查用户 task.text 的交付要求。本分类器自身必须返回 JSON 的协议不是用户任务的要求。
未要求额外能力时 requirements 必须为 []，不能默认填写 structured_output。
reusable 只有任务意图完整、材料足够、kind 非 mixed/unknown 且难度可确定时才为 true。
“继续”“修改第二条”等依赖未提供前文、缺必需材料、复合任务或类型模糊时为 false。
判断材料是否足够时，仅使用 task.text 内实际提供的材料，不能把候选资料当作待处理材料。
例：用户“写一个 Python 回文函数” => code_implement, routine, [], true。
例：用户“什么是光合作用？” => qa, routine, [], true。
例：用户“翻译下面的内容。”却没有给出原文 => translate, routine, [], false。
例：用户“把 hello 翻译成中文” => translate, routine, [], true。
例：用户“查询今天的天气” => research, routine, ["web"], true。
例：用户“写函数并调用终端执行测试” => code_implement, routine, ["tools"], true。
例：用户“写一个返回 JSON 的函数” => code_implement, routine, [], true。
例：用户“解释递归，只输出严格 JSON 对象” => qa, routine, ["structured_output"], true。
用户明确要求你实际执行终端/修改文件/调用工具时，必须标记 tools；仅提供代码或说明命令时不标记。
task_profile 不表达用户偏好，也不改变评分；不能因为需要记忆而强行选择类型。
"""
)


class TaskProfile(Contract):
    kind: str
    difficulty: Literal["routine", "complex", "unknown"]
    requirements: list[str] = Field(max_length=5)
    reusable: bool

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

    @model_validator(mode="after")
    def known(self):
        if self.reusable and (self.kind in {"mixed", "unknown"} or self.difficulty == "unknown"):
            raise ValueError("unknown profile cannot be reused")
        return self


def profile_schema():
    schema = TaskProfile.model_json_schema()
    schema["properties"]["kind"]["enum"] = list(TAXONOMY["kinds"])
    schema["properties"]["requirements"]["items"]["enum"] = TAXONOMY["requirements"]
    return schema
