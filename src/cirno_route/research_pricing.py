"""Evidence-backed official API reference prices, independent of subscription bills."""

import re
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import Field, model_validator

from .contracts import Contract

Rate = Annotated[float, Field(strict=True, ge=0, le=100000, allow_inf_nan=False)]
PRICE_DOMAINS = {
    "openai": ("openai.com",),
    "deepseek": ("deepseek.com",),
    "anthropic": ("anthropic.com", "claude.com"),
    "google": ("ai.google.dev", "aistudio.google.com", "cloud.google.com"),
    "zai": ("z.ai",),
    "xai": ("x.ai",),
    "tencent": ("tencentcloud.com",),
    "moonshot": ("platform.kimi.ai", "platform.moonshot.ai"),
    "alibaba": ("alibabacloud.com",),
}

# Explicit benchmark mappings, not assertions about a gateway's deployed backend.
GO_API_BASELINES = {
    "claude-haiku-5-5": "anthropic",
    "gemini-4-argon": "google",
    "glm-5.3": "zai",
    "glm-5.3-flash": "zai",
    "grok-4.7": "xai",
    "hy3": "tencent",
    "hy4": "tencent",
    "kimi-k3": "moonshot",
    "kimi-k3.1-pro": "moonshot",
    "qwen3.8-flash": "alibaba",
    "qwen3.8-max": "alibaba",
}
DISPLAY_NAMES = {"kimi-k3": ("K3",), "kimi-k3.1-pro": ("K3.1 Pro",)}


def price_identity(identity):
    provider = identity.provider
    if provider == "opencode-go":
        provider = GO_API_BASELINES.get(identity.model)
    if provider not in PRICE_DOMAINS:
        return None
    return SimpleNamespace(provider=provider, model=identity.model)


def price_names(identity):
    return (identity.model, *DISPLAY_NAMES.get(identity.model, ()))


class PriceFindings(Contract):
    status: Literal["known", "unknown", "subscription"] = "unknown"
    currency: Literal["USD"] = "USD"
    unit: Literal["per_million_tokens", "subscription", "unknown"] = "unknown"
    input_per_million: Rate | None = None
    output_per_million: Rate | None = None
    cache_read_per_million: Rate | None = None
    reference_input_per_million: Rate | None = None
    reference_output_per_million: Rate | None = None
    reference_cache_read_per_million: Rate | None = None
    source_ids: Annotated[list[str], Field(max_length=5)] = Field(default_factory=list)
    quote: Annotated[str, Field(max_length=9000)] = ""
    note: Annotated[str, Field(max_length=500)] = "未获得该渠道可核实的价格。"

    @model_validator(mode="after")
    def consistent(self):
        rates = (self.input_per_million, self.output_per_million, self.cache_read_per_million)
        reference = (
            self.reference_input_per_million,
            self.reference_output_per_million,
            self.reference_cache_read_per_million,
        )
        if self.status == "known":
            if self.unit != "per_million_tokens" or any(x is None for x in rates[:2]):
                raise ValueError("token prices require both standard rates")
        elif any(x is not None for x in rates):
            raise ValueError("unknown/subscription is not a zero token price")
        if self.status == "subscription" and self.unit != "subscription":
            raise ValueError("subscription prices require the subscription unit")
        if self.status != "subscription" and any(x is not None for x in reference):
            raise ValueError("reference rates only describe subscription allowance")
        if (reference[0] is None) != (reference[1] is None):
            raise ValueError("both reference input and output rates are required")
        if reference[2] is not None and reference[0] is None:
            raise ValueError("cache reference requires ordinary reference rates")
        if self.status != "unknown" and (not self.source_ids or not self.quote.strip()):
            raise ValueError("price requires quoted source evidence")
        return self


def parse_price(value):
    """A malformed price cannot discard independently valid capability findings."""
    try:
        return PriceFindings.model_validate(value) if value is not None else PriceFindings()
    except (TypeError, ValueError):
        return PriceFindings(note="价格字段校验未通过，未用于比较。")


def price_search_query(identity):
    target = price_identity(identity)
    if target is None:
        return None
    suffix = {
        "openai": " API Standard short context pricing USD per million tokens site:openai.com",
        "deepseek": (
            " API peak cache miss input output pricing USD per million tokens site:deepseek.com"
        ),
        "anthropic": " API pricing USD per million tokens site:platform.claude.com",
        "google": " Standard paid API pricing USD per million tokens site:aistudio.google.com",
        "zai": " API pricing USD per million tokens site:docs.z.ai",
        "xai": " API pricing USD per million tokens site:docs.x.ai",
        "tencent": " API standard pricing USD per million tokens site:tencentcloud.com",
        "moonshot": " API pricing USD per million tokens site:platform.kimi.ai",
        "alibaba": (
            " Singapore International API pricing USD per million tokens site:alibabacloud.com"
        ),
    }[target.provider]
    return target.model[: 128 - len(suffix)] + suffix


def official_price_source(provider, url):
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        if provider == "openai" and not (
            (host == "developers.openai.com" and parsed.path.startswith("/api/docs/"))
            or (host == "platform.openai.com" and parsed.path.startswith("/docs/"))
            or (
                host in {"openai.com", "www.openai.com"}
                and parsed.path.rstrip("/") == "/api/pricing"
            )
        ):
            return False
        if provider == "tencent" and not re.search(r"/document/product/1300/78937/?$", parsed.path):
            return False  # Techpedia can discuss third-party gateway prices.
        if provider == "alibaba" and "/model-studio/" not in parsed.path:
            return False  # PAI Token Service is a different calling channel.
        return (
            parsed.scheme == "https"
            and not parsed.username
            and not parsed.password
            and parsed.port in {None, 443}
            and any(host == d or host.endswith("." + d) for d in PRICE_DOMAINS.get(provider, ()))
        )
    except (TypeError, ValueError):
        return False


def model_in_quote(model, quote):
    parts = [re.escape(s) for s in re.split(r"[-_.\s]+", model) if s]
    return re.search(r"(?i)(?<![\w.-])" + r"[-_.\s]*".join(parts) + r"(?![\w.-])", quote)


def _cells(line):
    return [re.sub(r"<[^>]*>|[*`]", "", c).strip() for c in line.strip().strip("|").split("|")]


def _model_cell(model, cell):
    match = model_in_quote(model, cell)
    if not match or cell[: match.start()].strip():
        return False
    suffix = cell[match.end() :].strip()
    return not suffix or bool(
        re.fullmatch(
            r"(?i)\(\s*(?:\d+|\d+%\s+off|(?:≤|<=|>|≥|>=)\s*\d+[km]?\s+tokens)\s*\)", suffix
        )
    )


def _role(label):
    label = label.casefold()
    if re.search(r"long.context|长上下文|cache.?write|cached.?write", label):
        return None
    if re.search(
        r"cache.?read|cached.?read|cached.?input|cache.?hit|context caching|缓存命中|缓存读", label
    ):
        return "cache"
    if re.search(r"output|输出", label):
        return "output"
    if re.search(r"input|输入|cache.?miss|缓存未命中", label):
        return "input"
    return None


def _amount(cell):
    # Remove obsolete Markdown prices, but never select from multiple live values.
    cell = re.sub(r"~~[^~]*~~|<del>.*?</del>", "", cell)
    short = re.fullmatch(
        r"(?i)(\$\d+(?:\.\d+)?\s*/\s*MTok) for prompts up to ([\d,]+) tokens; "
        r"\$\d+(?:\.\d+)?\s*/\s*MTok for prompts over \2 tokens",
        cell.strip(),
    )
    if short and int(short[2].replace(",", "")) >= 1000:
        cell = short[1]
    cell = re.sub(r"(?i)\s*(?:per|/)\s*(?:1\s*m|million|1,000,000)\s*tokens?", "", cell)
    cell = re.sub(r"(?i)\s*/\s*mtok\b", "", cell)
    # The current, explicitly time-bounded introductory price; expiry is checked
    # separately by price_expiry. A future price line never supplies this number.
    cell = re.sub(r"(?i)\s+through November 30, 2026[.]?\s*$", "", cell)
    numbers = re.findall(r"(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w.])", cell)
    if len(numbers) != 1 or re.search(r"[%/]", cell):
        return None
    return float(numbers[0].replace(",", ""))


def _standard_context(provider, lines, index):
    # Headings fence off other pricing modes on pages with repeated model tables.
    preceding = lines[: index + 1]
    headings = [i for i, line in enumerate(preceding) if re.match(r"\s*#{1,6}\s", line)]
    start = headings[-1] if headings else max(0, index - 25)
    context = "\n".join(lines[start : index + 1])
    mode_text = "\n".join(
        line for line in _section_context(lines, index).splitlines() if "|" not in line
    )
    if re.search(
        r"(?i)\b(?:batch|ultrafast|off.?peak|free tier|priority)\b|低谷|免费层", mode_text
    ):
        return False
    if provider == "openai":
        return bool(re.search(r"(?i)\bstandard\b|标准", context)) and not re.search(
            r"(?i)\bfast\b|long.context|长上下文", mode_text
        )
    if provider == "deepseek":
        return bool(re.search(r"(?i)(?<!off.)\bpeak\b|高峰", context))
    if provider == "alibaba":
        regional = _section_context(lines, index)
        if re.search(
            r"(?i)\bUS\b|United States|\bGlobal\b|Europe|Mainland|美国|全球|欧盟|中国内地", regional
        ):
            return False
        return bool(re.search(r"(?i)Singapore|International|新加坡|国际", regional))
    return True


def _section_context(lines, index):
    # Inherit an introduction's units through its child headings, never from a
    # sibling price table (e.g. embeddings USD/1M versus text CNY/1K).
    headings = []
    active = [(-1, 0)]
    for position, line in enumerate(lines[: index + 1]):
        heading = re.match(r"\s*(#{1,6})\s", line)
        if heading:
            level = len(heading[1])
            headings.append(position)
            while active and active[-1][1] >= level:
                active.pop()
            active.append((position, level))
    return "\n".join(
        line
        for start, _level in active
        for line in lines[max(0, start) : next((h for h in headings if h > start), index + 1)]
    )


def _units_supported(lines, index):
    context = _section_context(lines, index)
    if re.search(r"(?i)\b(?:CNY|RMB|EUR|GBP|JPY|CAD|AUD)\b|人民币|欧元", context):
        return False
    if re.search(
        r"(?i)(?:per|/)\s*(?:1[ ,]?000|1\s*k|thousand)\s*(?:input |output )?tokens?"
        r"|每千|per\s+token\b",
        context,
    ):
        return False
    return bool(re.search(r"(?i)USD|US\$|\$|美元", context)) and bool(
        re.search(
            r"(?i)(?:million|1\s*m|1,000,000|1000000|百万)\s*"
            r"(?:input |output )?tokens?|每百万|\bMTok\b",
            context,
        )
    )


def _bound_rates(identity, quote, excerpt):
    """Bind rates to exact model cells and labelled columns, never a bag of numbers."""
    lines = excerpt.splitlines()
    bindings = []
    for index, line in enumerate(lines):
        if not model_in_quote(identity.model, line):
            continue
        # Evidence may quote a whole table, but the selected numeric row must occur
        # inside that quote. A neighboring model's numbers cannot authorize this row.
        if line.strip() not in quote:
            continue
        cells = _cells(line)
        model_cells = [i for i, cell in enumerate(cells) if _model_cell(identity.model, cell)]
        if identity.provider == "tencent" and len(model_cells) == 2:
            model_cells = model_cells[-1:]  # Display name followed by exact API Parameter.
        if len(model_cells) != 1:
            continue
        model_index = model_cells[0]
        if re.search(r"\(\s*(?:>=?|≥)\s*\d", cells[model_index]):
            continue  # The comparison uses 1K input, not a long-context tier.
        standard = _standard_context(identity.provider, lines, index)
        if len(cells) > 1:
            # Ordinary model-per-row tables. The nearest header supplies exact roles.
            for previous in range(index - 1, -1, -1) if standard else []:
                if re.match(r"\s*#{1,6}\s", lines[previous]):
                    break
                headers = _cells(lines[previous])
                roles = [_role(header) for header in headers]
                if "input" not in roles or "output" not in roles:
                    continue
                if len(headers) == len(cells) - 1 and model_index == 0:
                    roles.insert(0, None)  # Text extract omitted the Model header.
                if (
                    identity.provider == "moonshot"
                    and len(headers) == 3
                    and len(cells) > 3
                    and (
                        headers[0].lower() in {"name", "model"} and roles[1:] == ["input", "output"]
                    )
                ):
                    # Kimi's grouped cache header is sometimes omitted by search.
                    # The first two token columns stay explicit; cache stays unknown.
                    roles.extend([None] * (len(cells) - 3))
                if len(roles) != len(cells):
                    break
                values = {}
                for role, cell in zip(roles, cells, strict=True):
                    if role and role not in values:
                        values[role] = _amount(cell)
                    elif role:
                        values[role] = None  # Ambiguous repeated pricing columns.
                if _units_supported(lines, index):
                    bindings.append({**values, "quote": line})
                break
            # DeepSeek publishes a transposed model-per-column table.
            if identity.provider == "deepseek" and model_index > 0:
                values = {}
                current_role = None
                unit_index = index
                for following_index, following in enumerate(
                    lines[index + 1 : index + 70], index + 1
                ):
                    if re.match(r"\s*#{1,6}\s", following):
                        break
                    row = _cells(following)
                    labels = " ".join(row[: max(1, len(row) - len(cells) + 1)])
                    current_role = _role(labels) or current_role
                    peak = re.search(r"(?i)(?<!off.)\bpeak\b|高峰", labels)
                    off_peak = re.search(r"(?i)off.?peak|低谷", labels)
                    if (
                        current_role
                        and len(row) >= len(cells)
                        and not off_peak
                        and (peak or standard)
                        and following.strip() in quote
                    ):
                        # HTML merged cells can add an extra label column. Model
                        # prices always occupy the final N model-specific cells.
                        value = _amount(row[-(len(cells) - model_index)])
                        values[current_role] = value if current_role not in values else None
                        unit_index = following_index
                if _units_supported(lines, unit_index):
                    bindings.append({**values, "quote": "\n".join(lines[index : unit_index + 1])})
        # Plain text must bind each number explicitly on the exact model's line.
        labelled = {}
        for match in re.finditer(
            r"(?i)(cache(?:d)?[ -]?(?:read|input)|input|output|输入|输出|缓存读)"
            r"\s*(?:price|cost|价格)?\s*[:=]?\s*(?:USD\s*|US\$\s*|\$\s*)"
            r"(\d+(?:\.\d+)?)\b",
            line,
        ):
            role = _role(match[1])
            labelled[role] = float(match[2]) if role not in labelled else None
        if labelled and standard and _units_supported(lines, index):
            bindings.append({**labelled, "quote": line})
    return (
        bindings
        + _section_rates(identity, quote, lines)
        + _flat_tencent_rates(identity, quote, lines)
        + _google_intro_rates(identity, quote, lines)
        + _alibaba_scoped_rates(identity, quote, lines)
    )


def _alibaba_scoped_rates(identity, quote, lines):
    if identity.provider != "alibaba":
        return []
    result = []
    for start, line in enumerate(lines):
        if not re.match(r"#\s+", line) or not _model_cell(identity.model, line[2:].strip()):
            continue
        end = next(
            (i for i in range(start + 1, len(lines)) if re.match(r"#\s+", lines[i])), len(lines)
        )
        section = "\n".join(lines[start:end])
        pricing = re.search(r"(?im)^##\s+(?:Pricing|模型价格|模型價格)\s*$", section)
        if not pricing:
            continue
        section = section[pricing.start() :]
        scope = re.search(
            r"(?im)^(?:Scope\s*:\s*International|部署范围\s*[:：]\s*国际)\s*$", section
        )
        if not scope:
            continue
        mode_headers = [x for x in section[: scope.start()].splitlines() if re.match(r"\s*#", x)]
        if not _standard_context("official", mode_headers or [""], max(0, len(mode_headers) - 1)):
            continue
        tail = section[scope.end() :]
        tail = re.split(r"(?im)^(?:Scope\s*:|部署范围\s*[:：]|#{1,4}\s)", tail, maxsplit=1)[0]
        if not re.search(r"(?i)Price.*USD|价格.*USD", tail):
            continue
        cells = [x.strip() for x in tail.splitlines() if x.strip()]
        values = {}
        for i in range(len(cells) - 2):
            role = _role(cells[i])
            if role not in {"input", "output"} or re.search(r"(?i)cache|缓存", cells[i]):
                continue
            if not re.fullmatch(r"\d+(?:\.\d+)?", cells[i + 1]) or not re.fullmatch(
                r"(?i)Per 1M tokens|每百万\s*tokens", cells[i + 2]
            ):
                continue
            amount = float(cells[i + 1])
            values[role] = amount if role not in values or values[role] == amount else None
        fragment = "\n".join(lines[start:end])
        if values and fragment in quote:
            result.append({**values, "quote": fragment})
    return result


def _google_intro_rates(identity, quote, lines):
    if identity.provider != "google" or identity.model != "gemini-4-argon":
        return []
    result = []
    for line in lines:
        if line not in quote or not any(_model_cell(identity.model, cell) for cell in _cells(line)):
            continue
        match = re.search(
            r"(?i)through Nov(?:ember)? 30, 2026 at an introductory price of "
            r"\$(\d+(?:\.\d+)?)/1M input tokens and \$(\d+(?:\.\d+)?)/1M output tokens",
            line,
        )
        if match:
            result.append({"input": float(match[1]), "output": float(match[2]), "quote": line})
    return result


def _flat_tencent_rates(identity, quote, lines):
    if identity.provider != "tencent" or identity.model not in {"hy3", "hy4"}:
        return []
    result = []
    for i, line in enumerate(lines):
        if not _model_cell(identity.model, line.strip()):
            continue
        header = "\n".join(lines[max(0, i - 65) : i])
        if not re.search(r"(?is)Input Tokens.*USD.*Output Tokens.*USD.*Cache.*USD", header):
            continue
        headings = [x for x in _section_context(lines, i).splitlines() if re.match(r"\s*#", x)]
        if not _units_supported(lines, i) or not _standard_context(
            identity.provider, headings or [""], max(0, len(headings) - 1)
        ):
            continue
        cells = [
            (j, row.strip()) for j, row in enumerate(lines[i + 1 : i + 18], i + 1) if row.strip()
        ]
        if len(cells) < 4:
            continue
        values = [
            _amount(row) if re.fullmatch(r"\d+(?:\.\d+)?", row) else None for _, row in cells[:3]
        ]
        if any(value is None for value in values) or re.fullmatch(r"\d+(?:\.\d+)?", cells[3][1]):
            continue
        fragment = "\n".join(lines[i : cells[2][0] + 1])
        if fragment in quote:
            result.append(
                dict(zip(("input", "output", "cache"), values, strict=True)) | {"quote": fragment}
            )
    return result


def _section_rates(identity, quote, lines):
    """Model-heading price cards and vertical labelled tables on official model pages."""
    bindings = []
    for start, line in enumerate(lines):
        heading = re.match(r"\s*(#{1,6})\s+(.+)", line)
        if not heading:
            heading = re.match(r"\s*(title:)\s+(.+)", line)
        if not heading or not model_in_quote(identity.model, heading[2]):
            continue
        # A heading for a suffix/preview version is not the registered model.
        title = re.sub(r"[*`]", "", heading[2]).strip()
        if not _model_cell(identity.model, title) or re.search(r"\(\s*(?:>=?|≥)\s*\d", title):
            continue
        level = 0 if heading[1] == "title:" else len(heading[1])
        end = next(
            (
                i
                for i in range(start + 1, len(lines))
                if ((h := re.match(r"\s*(#{1,6})\s", lines[i])) and len(h[1]) <= level)
            ),
            len(lines),
        )
        values = {}
        last = start
        for index in range(start + 1, end):
            row = _cells(lines[index])
            # Official model cards may serialize each labelled field as two bullets.
            bullet = re.fullmatch(r"\s*[-*]\s+(Input|Output|Cached input)\s*", lines[index], re.I)
            if bullet and index + 1 < end:
                row = [bullet[1], re.sub(r"^\s*[-*]\s+", "", lines[index + 1])]
            if len(row) < 2 or not (role := _role(row[0])):
                continue
            if re.search(r"(?:>|≥)\s*\d", row[0]):
                continue
            if not _standard_context(identity.provider, lines, index):
                continue
            # For tiered tables only the explicitly short (<threshold) column is used.
            price_cell = row[1]
            for previous in range(index - 1, start, -1):
                header = _cells(lines[previous])
                paid = [i for i, x in enumerate(header) if re.search(r"paid tier", x, re.I)]
                free = any(re.search(r"free tier", x, re.I) for x in header)
                if len(header) == len(row) and free and not paid:
                    price_cell = ""
                    break
                if len(header) == len(row) and len(paid) == 1:
                    price_cell = row[paid[0]]
                    break
                if len(header) == len(row) and any(
                    re.search(r"(?:[<>≤≥]|short|long)", x) for x in header
                ):
                    short = [
                        i
                        for i, x in enumerate(header)
                        if i > 0
                        and re.search(r"(?:<|≤|short)", x, re.I)
                        and not re.search(r"(?:>|≥|long)", x, re.I)
                    ]
                    if len(short) != 1:
                        price_cell = ""
                    else:
                        price_cell = row[short[0]]
                    break
            amount = _amount(price_cell)
            if amount is not None and _units_supported(lines, index + (1 if bullet else 0)):
                values[role] = amount if role not in values or values[role] == amount else None
                last = index
        quoted = "\n".join(lines[start : last + 1])
        if values and quoted in quote:
            bindings.append({**values, "quote": quoted})
    return bindings


def extract_price(identity, sources):
    """Official tables determine standard rates; subscription allowances never do."""
    target = price_identity(identity)
    if target is None:
        return PriceFindings(note="该渠道型号尚无明确的官方 API 价格基准映射。")
    candidates = []
    for source in sources:
        if not official_price_source(target.provider, source.url):
            continue
        for model in price_names(target):
            named = SimpleNamespace(provider=target.provider, model=model)
            for bound in _bound_rates(named, source.excerpt, source.excerpt):
                if bound.get("input") is None or bound.get("output") is None:
                    continue
                try:
                    pricing = PriceFindings(
                        status="known",
                        unit="per_million_tokens",
                        source_ids=[source.source_id],
                        quote=bound["quote"],
                        input_per_million=bound["input"],
                        output_per_million=bound["output"],
                        cache_read_per_million=bound.get("cache"),
                        note={
                            "openai": (
                                "官方 Standard 短上下文价格，USD/百万 token；"
                                "不含 Batch、Fast、长上下文加价。"
                            ),
                            "deepseek": "官方高峰期价格，USD/百万 token；普通输入为缓存未命中。",
                            "alibaba": (
                                "官方新加坡 International 标准 API 参考价，"
                                "USD/百万 token；不代表渠道实际账单。"
                            ),
                            "tencent": (
                                "腾讯国际官网 USD/百万 token 目录价，"
                                "不应用限时折扣或套餐，不代表渠道实际账单。"
                            ),
                        }.get(
                            target.provider,
                            "模型厂商官方标准 API 参考价，USD/百万 token；"
                            "不计套餐，不代表渠道实际账单。",
                        ),
                    )
                except ValueError:
                    continue
                checked = validate_price(identity, pricing, [source])
                if checked.status != "unknown":
                    candidates.append(checked)
    if not candidates:
        return PriceFindings()
    signatures = {(p.input_per_million, p.output_per_million) for p in candidates}
    caches = {p.cache_read_per_million for p in candidates if p.cache_read_per_million is not None}
    if len(signatures) > 1 or len(caches) > 1:
        return PriceFindings(note="官方材料出现相互冲突的同型号价格，暂不用于比较。")
    return next((p for p in candidates if p.cache_read_per_million is not None), candidates[0])


def resolve_researched_price(identity, model_pricing, sources):
    deterministic = extract_price(identity, sources)
    if deterministic.status != "unknown":
        return deterministic
    if "相互冲突" in deterministic.note:
        return deterministic  # An LLM must not arbitrate contradictory source prices.
    return validate_price(identity, model_pricing, sources)


def validate_price(identity, pricing, sources):
    if pricing.status == "unknown":
        return pricing
    if pricing.status == "subscription":
        return PriceFindings(note="旧套餐价格已停用，等待查询模型厂商官方 API 参考价。")
    target = price_identity(identity)
    if target is None:
        return PriceFindings(note="该渠道型号尚无明确的官方 API 价格基准映射。")
    selected = [s for s in sources if s.source_id in pricing.source_ids]
    if len(selected) != len(set(pricing.source_ids)) or not all(
        official_price_source(target.provider, s.url) for s in selected
    ):
        return PriceFindings(note="缺少该准确型号的模型厂商官方 API 价格来源。")
    quoted = next((s for s in selected if pricing.quote in s.excerpt), None)
    if quoted is None or not any(model_in_quote(n, pricing.quote) for n in price_names(target)):
        return PriceFindings(note="价格原文未明确包含该精确型号，未用于比较。")
    rates = (pricing.input_per_million, pricing.output_per_million, pricing.cache_read_per_million)
    if not any(
        all(
            rate is None or bound.get(role) == rate
            for role, rate in zip(("input", "output", "cache"), rates, strict=True)
        )
        for name in price_names(target)
        for bound in _bound_rates(
            SimpleNamespace(provider=target.provider, model=name), pricing.quote, quoted.excerpt
        )
    ):
        return PriceFindings(note="未能将准确型号与标准输入、输出及缓存价格逐列核对，未用于比较。")
    return pricing


def quote_expiry(identity, p):
    target = price_identity(identity)
    # Official Argon introductory prices expire at the announced UTC boundary.
    # A later retrieval of an old search snippet cannot renew the expired rates.
    if (
        target
        and target.provider == "google"
        and target.model == "gemini-4-argon"
        and (
            (p.input_per_million, p.output_per_million) == (2, 10)
            or re.search(r"(?i)through Nov(?:ember)? 30, 2026", p.quote)
        )
    ):
        return datetime(2026, 12, 1, tzinfo=UTC).timestamp()
    return float("inf")


def price_expiry(profile):
    return min(
        profile.pricing_expires_at or profile.expires_at,
        profile.expires_at,
        quote_expiry(profile.identity, profile.findings.pricing),
    )


def price_result(profile, now=None):
    if not profile:
        return {"status": "unknown", "currency": "USD", "note": "尚无有效价格研究记录。"}
    price = profile.findings.pricing
    expires_at = price_expiry(profile)
    retrieved_at = profile.pricing_retrieved_at or profile.retrieved_at
    if now is not None and expires_at <= now:
        return {"status": "unknown", "currency": "USD", "note": "价格研究记录已过期。"}
    if price.status != "known":
        return {"status": "unknown", "currency": "USD", "note": price.note}
    source = next(
        s for s in profile.sources if s.source_id in price.source_ids and price.quote in s.excerpt
    )
    return {
        "status": price.status,
        "currency": "USD",
        "input_per_million": price.input_per_million,
        "output_per_million": price.output_per_million,
        "cache_read_per_million": price.cache_read_per_million,
        "reference_input_per_million": price.reference_input_per_million,
        "reference_output_per_million": price.reference_output_per_million,
        "reference_cache_read_per_million": price.reference_cache_read_per_million,
        "source": "official"
        if profile.identity.provider == price_identity(profile.identity).provider
        else "reference",
        "pricing_basis": "official_api",
        "reference_provider": price_identity(profile.identity).provider,
        "reference_model": price_identity(profile.identity).model,
        "source_url": source.url,
        "checked_at": datetime.fromtimestamp(retrieved_at, UTC).date().isoformat(),
        "valid_until": datetime.fromtimestamp(expires_at, UTC).date().isoformat(),
        "expires_at": expires_at,
        "note": price.note,
    }
