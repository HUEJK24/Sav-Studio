from __future__ import annotations

import json
import math
import unicodedata
from datetime import date, datetime, time
from typing import Any, Iterable, Iterator

NULL_OPERATORS = {"isNull", "notNull"}


def _normalize_text(value: Any) -> str:
    folded = unicodedata.normalize("NFD", str(value).strip().casefold())
    return "".join(character for character in folded if not unicodedata.combining(character))


def _is_empty(value: Any) -> bool:
    return value is None or value == ""


def _is_filled(value: Any) -> bool:
    return value is not None and str(value) != ""


def normalize_text(value: Any) -> str:
    return _normalize_text(value)


def as_number(value: Any) -> float:
    return _as_number(value)


def _as_number(value: Any) -> float:
    if isinstance(value, bool):
        return math.nan
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return math.nan
        try:
            return float(text)
        except ValueError:
            return math.nan
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def _as_time(value: Any) -> float:
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, date):
        return datetime.combine(value, time()).timestamp()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip()
    if not text:
        return math.nan
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return math.nan


def rule_is_active(rule: dict[str, Any]) -> bool:
    if not rule.get("field") or not rule.get("operator"):
        return False
    operator = rule["operator"]
    if operator in NULL_OPERATORS:
        return True
    if operator == "between":
        return _is_filled(rule.get("min")) or _is_filled(rule.get("max"))
    if operator == "in":
        return True
    return _is_filled(rule.get("value"))


def _equals(value: Any, expected: Any, kind: str) -> bool:
    if kind == "numeric":
        left = _as_number(value)
        right = _as_number(expected)
        return not math.isnan(left) and not math.isnan(right) and left == right
    if kind == "date":
        left = _as_time(value)
        right = _as_time(expected)
        return not math.isnan(left) and not math.isnan(right) and left == right
    return _normalize_text(value) == _normalize_text(expected)


def test_rule(value: Any, rule: dict[str, Any]) -> bool:
    operator = rule.get("operator")
    kind = rule.get("kind") or "string"

    if operator == "isNull":
        return _is_empty(value)
    if operator == "notNull":
        return not _is_empty(value)
    if _is_empty(value):
        return False

    text = str(value)
    needle = str(rule.get("value") or "")

    if operator == "equals":
        return _equals(value, rule.get("value"), kind)
    if operator == "notEquals":
        return not _equals(value, rule.get("value"), kind)
    if operator == "contains":
        return _normalize_text(needle) in _normalize_text(text)
    if operator == "notContains":
        return _normalize_text(needle) not in _normalize_text(text)
    if operator == "startsWith":
        return _normalize_text(text).startswith(_normalize_text(needle))
    if operator == "endsWith":
        return _normalize_text(text).endswith(_normalize_text(needle))

    if operator in {"greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"}:
        if kind == "date":
            left = _as_time(value)
            right = _as_time(rule.get("value"))
        else:
            left = _as_number(value)
            right = _as_number(rule.get("value"))
        if math.isnan(left) or math.isnan(right):
            return False
        if operator == "greaterThan":
            return left > right
        if operator == "greaterThanOrEqual":
            return left >= right
        if operator == "lessThan":
            return left < right
        return left <= right

    if operator == "between":
        has_min = _is_filled(rule.get("min"))
        has_max = _is_filled(rule.get("max"))
        if kind == "date":
            current = _as_time(value)
            if math.isnan(current):
                return False
            if has_min and current < _as_time(rule.get("min")):
                return False
            if has_max and current > _as_time(rule.get("max")):
                return False
            return True
        current = _as_number(value)
        if math.isnan(current):
            return False
        if has_min and current < _as_number(rule.get("min")):
            return False
        if has_max and current > _as_number(rule.get("max")):
            return False
        return True

    if operator == "in":
        normalized_value = _normalize_text(text)
        return any(
            _normalize_text(item) == normalized_value
            for item in (rule.get("values") or [])
        )

    return True


def build_predicate(rules: list[dict[str, Any]], match_mode: str = "all"):
    active = [rule for rule in rules or [] if rule_is_active(rule)]
    if not active:
        return None

    if match_mode == "any":
        return lambda row: any(test_rule(row.get(rule["field"]), rule) for rule in active)
    return lambda row: all(test_rule(row.get(rule["field"]), rule) for rule in active)


def filter_rows(
    rows: Iterable[dict[str, Any]],
    rules: list[dict[str, Any]],
    match_mode: str = "all",
) -> Iterator[dict[str, Any]]:
    predicate = build_predicate(rules, match_mode)
    if predicate is None:
        yield from rows
        return
    for row in rows:
        if predicate(row):
            yield row


def filter_signature(rules: list[dict[str, Any]], match_mode: str = "all") -> str:
    keys = ("field", "kind", "operator", "value", "min", "max", "values")
    normalized = [
        {key: rule.get(key) for key in keys if key in rule}
        for rule in rules or []
        if rule_is_active(rule)
    ]
    return json.dumps(
        {"rules": normalized, "matchMode": match_mode or "all"},
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
