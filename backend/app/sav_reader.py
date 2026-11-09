from __future__ import annotations

import math
import json
import os
import threading
from collections import Counter
from datetime import date, datetime, time
from pathlib import Path
from time import time as unix_time
from typing import Any, Callable, Iterator

import numpy as np
import pandas as pd
import pyreadstat
import duckdb

from .config import CACHE_CHUNK_ROWS, CACHE_COMPRESSION, CACHE_ROW_GROUP_SIZE
from .filters import as_number, normalize_text
from .store import Dataset
from .utils import path_has_files, remove_path

DATE_FORMAT_PREFIXES = (
    "DATE",
    "ADATE",
    "EDATE",
    "SDATE",
    "JDATE",
    "DATETIME",
    "QYR",
    "MOYR",
    "WKYR",
    "TIME",
)


def _serialize_datetime(value: Any) -> str:
    if isinstance(value, pd.Timestamp):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        if value.time() == time(0, 0):
            return value.date().isoformat()
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    return str(value)


def _serialize_value(value: Any, label_map: dict[Any, str]) -> Any:
    if value is None:
        return None

    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass

    if isinstance(value, (pd.Timestamp, datetime, date, time)):
        return _serialize_datetime(value)

    if isinstance(value, np.generic):
        value = value.item()

    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")

    if label_map:
        label = label_map.get(value)
        if label is None and isinstance(value, (int, float)) and not isinstance(value, bool):
            label = label_map.get(float(value))
            if label is None:
                label = label_map.get(int(value))
        if label is not None:
            return label

    if isinstance(value, bool):
        return value

    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer():
            return int(value)
        return round(value, 10)

    if isinstance(value, (int, str)):
        return value

    return str(value)


def _normalize_label_map(raw: dict[Any, Any] | None) -> dict[Any, str]:
    if not raw:
        return {}

    normalized: dict[Any, str] = {}
    for key, value in raw.items():
        label = str(value)
        normalized[key] = label
        if isinstance(key, (int, float)) and not isinstance(key, bool):
            normalized[int(key)] = label
            normalized[float(key)] = label
        else:
            try:
                normalized[int(key)] = label
            except (TypeError, ValueError):
                pass
    return normalized


def _label_map_for_json(raw: dict[Any, Any] | None) -> dict[str, str]:
    if not raw:
        return {}

    def sort_key(item: tuple[Any, Any]) -> tuple[int, Any]:
        key = item[0]
        if isinstance(key, (int, float)) and not isinstance(key, bool):
            return (0, float(key))
        return (1, str(key))

    def label_key(key: Any) -> str:
        if isinstance(key, float) and key.is_integer():
            return str(int(key))
        return str(key)

    return {
        label_key(key): str(value) for key, value in sorted(raw.items(), key=sort_key)
    }


def _variable_type(series: pd.Series, spss_format: str | None) -> str:
    fmt = (spss_format or "").upper()
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date"
    if fmt.startswith(DATE_FORMAT_PREFIXES):
        return "date"
    if pd.api.types.is_numeric_dtype(series) or pd.api.types.is_bool_dtype(series):
        return "numeric"
    return "string"


def _json_number(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, 6)
    return value


def _missing_ranges_for_json(ranges: Any) -> list[list[Any]]:
    if not ranges:
        return []

    result: list[list[Any]] = []
    for item in ranges:
        try:
            low, high = item
        except (TypeError, ValueError):
            continue
        result.append([_json_number(low), _json_number(high)])
    return result


def _stats_for(series: pd.Series, variable_type: str) -> dict[str, Any]:
    stats: dict[str, Any] = {
        "count": int(series.notna().sum()),
        "missing": int(series.isna().sum()),
        "unique": int(series.nunique(dropna=True)),
    }

    if variable_type == "numeric":
        numeric = pd.to_numeric(series, errors="coerce").dropna()
        if not numeric.empty:
            stats.update(
                min=_json_number(numeric.min()),
                max=_json_number(numeric.max()),
                mean=_json_number(numeric.mean()),
                median=_json_number(numeric.median()),
                std=_json_number(numeric.std()),
            )
    elif variable_type == "date":
        valid = series.dropna()
        if not valid.empty:
            stats["min"] = _serialize_datetime(valid.min())
            stats["max"] = _serialize_datetime(valid.max())

    return stats


def _categories_for(
    counts: Counter[Any],
    raw_labels: dict[Any, Any] | None,
) -> list[dict[str, Any]]:
    if raw_labels:
        categories: list[dict[str, Any]] = []
        seen: set[str] = set()
        for value in raw_labels.values():
            label = str(value)
            if label in seen:
                continue
            seen.add(label)
            categories.append(
                {"value": label, "label": label, "count": int(counts.get(label, 0))}
            )

        extras = [
            (value, count)
            for value, count in counts.items()
            if value is not None and str(value) not in seen
        ]
        extras.sort(key=lambda item: (-item[1], str(item[0]).lower()))
        for value, count in extras:
            categories.append(
                {"value": value, "label": str(value), "count": int(count)}
            )
        return categories

    def sort_key(item: tuple[Any, int]) -> tuple[int, Any]:
        value = item[0]
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return (0, value)
        return (1, str(value).lower())

    return [
        {"value": value, "label": str(value), "count": int(count)}
        for value, count in sorted(counts.items(), key=sort_key)
        if value is not None
    ]


def read_sav_rows(
    path: str,
    offset: int,
    limit: int,
    variables: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    df, meta = pyreadstat.read_sav(
        path,
        apply_value_formats=False,
        formats_as_category=False,
        user_missing=False,
        row_offset=offset,
        row_limit=limit,
    )
    column_names = list(getattr(meta, "column_names", None) or list(df.columns))
    label_maps = {
        variable["name"]: _normalize_label_map(variable.get("value_labels"))
        for variable in variables
    }

    return [
        {
            name: _serialize_value(value, label_maps.get(name, {}))
            for name, value in zip(column_names, record)
        }
        for record in df.itertuples(index=False, name=None)
    ]


def _json_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _serialize_value(value, {})


def _iter_json_array(path: str) -> Iterator[dict[str, Any]]:
    decoder = json.JSONDecoder()
    with open(path, encoding="utf-8-sig") as source:
        buffer = ""
        position = 0
        eof = False

        def refill() -> None:
            nonlocal buffer, position, eof
            buffer = buffer[position:]
            position = 0
            chunk = source.read(64 * 1024)
            if chunk:
                buffer += chunk
            else:
                eof = True

        def skip_whitespace() -> None:
            nonlocal position
            while True:
                while position < len(buffer) and buffer[position].isspace():
                    position += 1
                if position < len(buffer) or eof:
                    return
                refill()

        skip_whitespace()
        if position >= len(buffer) or buffer[position] != "[":
            raise ValueError("El JSON debe ser una lista de objetos (filas de datos).")
        position += 1
        first = True

        while True:
            skip_whitespace()
            if position >= len(buffer):
                raise ValueError("El JSON terminó antes de cerrar la lista de filas.")
            if buffer[position] == "]":
                position += 1
                skip_whitespace()
                if position < len(buffer):
                    raise ValueError("El JSON contiene datos después de la lista de filas.")
                return

            if not first:
                if buffer[position] != ",":
                    raise ValueError("El JSON debe separar las filas con comas.")
                position += 1
                skip_whitespace()
                if position >= len(buffer) or buffer[position] == "]":
                    raise ValueError("El JSON contiene una fila vacía.")
            first = False

            while True:
                try:
                    row, end = decoder.raw_decode(buffer, position)
                except json.JSONDecodeError as exc:
                    if eof:
                        raise ValueError(f"El JSON contiene datos no válidos: {exc}") from exc
                    refill()
                    continue
                if not isinstance(row, dict):
                    raise ValueError("El JSON debe ser una lista de objetos (filas de datos).")
                position = end
                yield row
                break


def read_json_rows(path: str, offset: int, limit: int) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    result = []
    end = offset + limit
    for index, row in enumerate(_iter_json_array(path)):
        if index >= end:
            break
        if index >= offset:
            result.append({str(name): _json_value(value) for name, value in row.items()})
    return result


def read_json_dataset(
    path: str,
    file_name: str,
    dataset_id: str,
    max_rows: int,
    max_cells: int = 0,
) -> Dataset:
    column_names: list[str] = []
    column_names_seen: set[str] = set()
    sample_rows: list[dict[str, Any]] = []
    source_row_count = 0
    row_budget = max_rows

    for source_row in _iter_json_array(path):
        source_row_count += 1
        for name in source_row:
            normalized_name = str(name)
            if normalized_name not in column_names_seen:
                column_names_seen.add(normalized_name)
                column_names.append(normalized_name)
        if max_cells > 0 and column_names:
            cell_budget = max(1, max_cells // len(column_names))
            row_budget = min(max_rows, cell_budget) if max_rows > 0 else cell_budget
            if len(sample_rows) > row_budget:
                del sample_rows[row_budget:]
        if row_budget <= 0 or len(sample_rows) < row_budget:
            sample_rows.append(source_row)

    rows = [
        {name: _json_value(record.get(name)) for name in column_names}
        for record in sample_rows
    ]

    variables: list[dict[str, Any]] = []
    for name in column_names:
        values = [row.get(name) for row in rows]
        series = pd.Series(values, dtype="object")
        non_missing = [value for value in values if value is not None]
        is_numeric = bool(non_missing) and all(
            isinstance(value, (int, float, np.number)) and not isinstance(value, bool)
            for value in non_missing
        )
        variable_type = "numeric" if is_numeric else "string"
        counts = Counter(value for value in values if value is not None)
        categories = _categories_for(counts, None) if len(counts) <= 200 else []
        variables.append(
            {
                "name": str(name),
                "label": str(name),
                "type": variable_type,
                "spss_format": None,
                "measure": "unknown",
                "display_width": None,
                "has_value_labels": False,
                "value_labels": {},
                "missing_ranges": [],
                "categories": categories,
                "stats": _stats_for(series, variable_type),
            }
        )

    truncated = source_row_count > len(rows)
    warnings = []
    if truncated:
        warnings.append(
            f"El JSON contiene {source_row_count:,} filas y {len(column_names):,} variables; "
            f"se cargaron {len(rows):,} como muestra inicial. La tabla permite recorrer "
            "todas las filas por páginas."
        )

    return Dataset(
        id=dataset_id,
        file_name=file_name,
        created_at=unix_time(),
        variables=variables,
        rows=rows,
        source_row_count=source_row_count,
        truncated=truncated,
        warnings=warnings,
    )


def read_dataset(
    path: str,
    file_name: str,
    dataset_id: str,
    max_rows: int,
    max_cells: int = 0,
) -> Dataset:
    if file_name.lower().endswith(".json"):
        return read_json_dataset(path, file_name, dataset_id, max_rows, max_cells)
    return read_sav_dataset(path, file_name, dataset_id, max_rows, max_cells)


def read_dataset_rows(
    path: str,
    file_name: str,
    offset: int,
    limit: int,
    variables: list[dict[str, Any]],
    cache_path: str | None = None,
    cache_row_index: str = "__sav_studio_row_index__",
) -> list[dict[str, Any]]:
    if file_name.lower().endswith(".json"):
        return read_json_rows(path, offset, limit)
    if cache_path and os.path.exists(cache_path):
        return _sav_cache_rows(
            cache_path,
            variables,
            cache_row_index,
            offset,
            limit,
        )
    return read_sav_rows(path, offset, limit, variables)


def iter_sav_rows(
    path: str,
    variables: list[dict[str, Any]],
    chunk_size: int = 2000,
):
    label_maps = {
        variable["name"]: _normalize_label_map(variable.get("value_labels"))
        for variable in variables
    }
    column_names: list[str] | None = None

    for chunk, meta in pyreadstat.read_file_in_chunks(
        pyreadstat.read_sav,
        path,
        chunksize=chunk_size,
        apply_value_formats=False,
        formats_as_category=False,
        user_missing=False,
    ):
        if column_names is None:
            column_names = list(getattr(meta, "column_names", None) or list(chunk.columns))
        for record in chunk.itertuples(index=False, name=None):
            yield {
                name: _serialize_value(value, label_maps.get(name, {}))
                for name, value in zip(column_names, record)
            }


_CACHE_LOCAL = threading.local()


def _read_connection() -> duckdb.DuckDBPyConnection:
    connection = getattr(_CACHE_LOCAL, "connection", None)
    if connection is None:
        connection = duckdb.connect()
        try:
            connection.execute("SET enable_external_file_cache = false")
        except Exception:
            pass
        _CACHE_LOCAL.connection = connection
    return connection


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _parquet_glob(cache_path: str) -> str:
    return (Path(cache_path) / "*.parquet").as_posix()


def _parquet_relation(cache_path: str) -> str:
    return f"read_parquet({_sql_literal(_parquet_glob(cache_path))})"


def _needs_norm(variable: dict[str, Any]) -> bool:
    return bool(
        variable.get("has_value_labels")
        or variable.get("value_labels")
        or variable.get("type") in {"string", "date"}
    )


def _aux_column_names(
    variables: list[dict[str, Any]],
    row_index_name: str,
) -> dict[str, str]:
    taken = {variable["name"] for variable in variables}
    taken.add(row_index_name)
    names: dict[str, str] = {}
    for variable in variables:
        if not _needs_norm(variable):
            continue
        candidate = f"__sav_norm__{variable['name']}"
        while candidate in taken:
            candidate = f"_{candidate}"
        taken.add(candidate)
        names[variable["name"]] = candidate
    return names


def _raw_expression(variable: dict[str, Any], column: str) -> str:
    variable_type = variable.get("type")
    if variable_type == "numeric":
        return f"TRY_CAST({column} AS DOUBLE)"
    if variable_type == "date":
        return f"TRY_CAST({column} AS TIMESTAMP)"
    return f"CAST({column} AS VARCHAR)"


def _display_expression(variable: dict[str, Any], column: str) -> str:
    variable_type = variable.get("type")
    if variable_type == "numeric":
        return (
            f"CASE WHEN {column} IS NULL OR isnan({column}) THEN NULL "
            f"WHEN {column} = trunc({column}) "
            f"AND abs({column}) < 1000000000000000 "
            f"THEN CAST(CAST({column} AS BIGINT) AS VARCHAR) "
            f"ELSE CAST({column} AS VARCHAR) END"
        )
    if variable_type == "date":
        return (
            f"CASE WHEN {column} IS NULL THEN NULL "
            f"WHEN CAST({column} AS TIMESTAMP) = "
            f"CAST(CAST({column} AS DATE) AS TIMESTAMP) "
            f"THEN strftime(CAST({column} AS DATE), '%Y-%m-%d') "
            f"ELSE strftime(CAST({column} AS TIMESTAMP), '%Y-%m-%dT%H:%M:%S') END"
        )
    return f"CAST({column} AS VARCHAR)"


def _label_expression(variable: dict[str, Any], column: str) -> str:
    labels = variable.get("value_labels") or {}
    fallback = _display_expression(variable, column)
    if not labels:
        return fallback
    variable_type = variable.get("type")
    cases: list[str] = []
    for raw_value, label in labels.items():
        if variable_type == "numeric":
            try:
                numeric_value = float(raw_value)
            except (TypeError, ValueError):
                condition = f"CAST({column} AS VARCHAR) = {_sql_literal(str(raw_value))}"
            else:
                condition = f"{column} = {numeric_value!r}"
        elif variable_type == "date":
            condition = f"{column} = TRY_CAST({_sql_literal(str(raw_value))} AS TIMESTAMP)"
        else:
            condition = f"CAST({column} AS VARCHAR) = {_sql_literal(str(raw_value))}"
        cases.append(f"WHEN {condition} THEN {_sql_literal(str(label))}")
    return "CASE " + " ".join(cases) + f" ELSE {fallback} END"


def _norm_expression(variable: dict[str, Any], column: str) -> str:
    return f"strip_accents(lower(trim({_label_expression(variable, column)})))"


def _cache_select_sql(
    variables: list[dict[str, Any]],
    row_index_name: str,
) -> str:
    norm_names = _aux_column_names(variables, row_index_name)
    parts: list[str] = []
    for variable in variables:
        name = variable["name"]
        raw = _raw_expression(variable, _quoted_identifier(name))
        parts.append(f"{raw} AS {_quoted_identifier(name)}")
        norm_name = norm_names.get(name)
        if norm_name:
            parts.append(
                f"{_norm_expression(variable, raw)} AS {_quoted_identifier(norm_name)}"
            )
    parts.append(_quoted_identifier(row_index_name))
    return "SELECT " + ", ".join(parts) + ' FROM "_sav_studio_chunk"'


def build_sav_cache(
    path: str,
    cache_path: str,
    variables: list[dict[str, Any]],
    chunk_size: int = CACHE_CHUNK_ROWS,
    progress_callback: Callable[[int], None] | None = None,
) -> str:
    column_names = [variable["name"] for variable in variables]
    row_index_name = "__sav_studio_row_index__"
    while row_index_name in column_names:
        row_index_name = f"_{row_index_name}"

    remove_path(cache_path)
    os.makedirs(cache_path, exist_ok=True)
    select_sql = _cache_select_sql(variables, row_index_name)
    compression = CACHE_COMPRESSION.upper()
    if compression not in {"UNCOMPRESSED", "SNAPPY", "GZIP", "ZSTD"}:
        compression = "ZSTD"

    connection = duckdb.connect()
    written = 0
    part_index = 0
    try:
        for chunk, _ in pyreadstat.read_file_in_chunks(
            pyreadstat.read_sav,
            path,
            chunksize=chunk_size,
            apply_value_formats=False,
            formats_as_category=False,
            user_missing=False,
        ):
            if chunk.empty:
                continue
            chunk.insert(
                0,
                row_index_name,
                np.arange(written, written + len(chunk), dtype=np.int64),
            )
            connection.register("_sav_studio_chunk", chunk)
            try:
                part_path = (Path(cache_path) / f"part-{part_index:05d}.parquet").as_posix()
                connection.execute(
                    f"COPY ({select_sql}) TO {_sql_literal(part_path)} "
                    f"(FORMAT PARQUET, COMPRESSION {compression}, "
                    f"ROW_GROUP_SIZE {max(1, CACHE_ROW_GROUP_SIZE)})"
                )
            finally:
                connection.unregister("_sav_studio_chunk")
            written += len(chunk)
            part_index += 1
            if progress_callback:
                progress_callback(written)

        if written == 0:
            raise ValueError("El archivo SPSS no contiene filas para indexar.")
    except Exception:
        remove_path(cache_path)
        raise
    finally:
        connection.close()

    return row_index_name


def _quoted_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _cache_label_maps(
    variables: list[dict[str, Any]],
    names: list[str] | None = None,
) -> dict[str, dict[Any, str]]:
    allowed = set(names) if names is not None else None
    return {
        variable["name"]: _normalize_label_map(variable.get("value_labels"))
        for variable in variables
        if allowed is None or variable["name"] in allowed
    }


def _serialize_cache_record(
    record: tuple[Any, ...],
    names: list[str],
    label_maps: dict[str, dict[Any, str]],
) -> dict[str, Any]:
    return {
        name: _serialize_value(value, label_maps.get(name, {}))
        for name, value in zip(names, record)
    }


def _sav_cache_rows(
    cache_path: str,
    variables: list[dict[str, Any]],
    row_index_name: str,
    offset: int,
    limit: int,
) -> list[dict[str, Any]]:
    if limit <= 0:
        return []

    names = [variable["name"] for variable in variables]
    selected = ", ".join(_quoted_identifier(name) for name in names)
    if selected:
        selected += ", "
    index_column = _quoted_identifier(row_index_name)
    relation = _parquet_relation(cache_path)
    query = (
        f"SELECT {selected}{index_column} FROM {relation} "
        f"WHERE {index_column} >= ? AND {index_column} < ? "
        f"ORDER BY {index_column}"
    )
    records = _read_connection().execute(query, [offset, offset + limit]).fetchall()
    label_maps = _cache_label_maps(variables)
    return [_serialize_cache_record(record, names, label_maps) for record in records]


def _iter_sav_cache_rows(
    cache_path: str,
    variables: list[dict[str, Any]],
    row_index_name: str,
    columns: list[str] | None = None,
    chunk_size: int = 2000,
):
    names = [variable["name"] for variable in variables]
    selected_names = names if columns is None else [name for name in columns if name in names]
    selected = ", ".join(_quoted_identifier(name) for name in selected_names)
    if selected:
        selected += ", "
    index_column = _quoted_identifier(row_index_name)
    relation = _parquet_relation(cache_path)
    query = (
        f"SELECT {selected}{index_column} FROM {relation} "
        f"ORDER BY {index_column}"
    )
    label_maps = _cache_label_maps(variables, selected_names)
    cursor = _read_connection().execute(query)
    while records := cursor.fetchmany(chunk_size):
        for record in records:
            yield _serialize_cache_record(record, selected_names, label_maps)


def read_sav_cache_indices(
    cache_path: str,
    variables: list[dict[str, Any]],
    row_index_name: str,
    indices: list[int],
) -> list[dict[str, Any]]:
    if not indices:
        return []

    names = [variable["name"] for variable in variables]
    selected = ", ".join(_quoted_identifier(name) for name in names)
    if selected:
        selected += ", "
    index_column = _quoted_identifier(row_index_name)
    relation = _parquet_relation(cache_path)
    placeholders = ", ".join("?" for _ in indices)
    query = (
        f"SELECT {selected}{index_column} FROM {relation} "
        f"WHERE {index_column} IN ({placeholders}) ORDER BY {index_column}"
    )
    records = _read_connection().execute(query, indices).fetchall()
    label_maps = _cache_label_maps(variables)
    return [_serialize_cache_record(record, names, label_maps) for record in records]


def _rule_kind(variable: dict[str, Any], rule: dict[str, Any]) -> str:
    kind = rule.get("kind")
    if kind in {"numeric", "date", "categorical", "string"}:
        return kind
    if variable.get("has_value_labels") or variable.get("value_labels"):
        return "categorical"
    if variable.get("type") == "numeric":
        return "numeric"
    if variable.get("type") == "date":
        return "date"
    return "string"


def _numeric_value(value: Any) -> float | None:
    number = as_number(value)
    return None if math.isnan(number) else number


def _rule_clause(
    variable: dict[str, Any],
    rule: dict[str, Any],
    norm_names: dict[str, str],
) -> tuple[str, list[Any]] | None:
    operator = rule.get("operator")
    if not operator:
        return None
    kind = _rule_kind(variable, rule)
    raw_name = variable["name"]
    norm_name = norm_names.get(raw_name)

    if kind == "numeric":
        column = _quoted_identifier(raw_name)
        not_null = f"({column} IS NOT NULL AND NOT isnan({column}))"
        if operator == "isNull":
            return f"({column} IS NULL OR isnan({column}))", []
        if operator == "notNull":
            return not_null, []
        if operator in {"equals", "notEquals"}:
            number = _numeric_value(rule.get("value"))
            if number is None:
                return ("FALSE", []) if operator == "equals" else (not_null, [])
            comparison = "=" if operator == "equals" else "<>"
            return f"({not_null} AND {column} {comparison} ?)", [number]
        if operator in {
            "greaterThan",
            "greaterThanOrEqual",
            "lessThan",
            "lessThanOrEqual",
        }:
            number = _numeric_value(rule.get("value"))
            if number is None:
                return "FALSE", []
            comparison = {
                "greaterThan": ">",
                "greaterThanOrEqual": ">=",
                "lessThan": "<",
                "lessThanOrEqual": "<=",
            }[operator]
            return f"({not_null} AND {column} {comparison} ?)", [number]
        if operator == "between":
            lower = _numeric_value(rule.get("min"))
            upper = _numeric_value(rule.get("max"))
            clauses = [not_null]
            parameters: list[Any] = []
            if lower is not None:
                clauses.append(f"{column} >= ?")
                parameters.append(lower)
            if upper is not None:
                clauses.append(f"{column} <= ?")
                parameters.append(upper)
            if not parameters:
                return not_null, []
            return "(" + " AND ".join(clauses) + ")", parameters
        if operator == "in":
            numbers = [_numeric_value(value) for value in rule.get("values") or []]
            numbers = [number for number in numbers if number is not None]
            if not numbers:
                return "FALSE", []
            placeholders = ", ".join("?" for _ in numbers)
            return f"({not_null} AND {column} IN ({placeholders}))", numbers
        return None

    if kind in {"date", "categorical", "string"}:
        if norm_name is None:
            return None
        column = _quoted_identifier(norm_name)
        guard = f"({column} IS NOT NULL AND {column} <> '')"
        if operator == "isNull":
            return f"({column} IS NULL OR {column} = '')", []
        if operator == "notNull":
            return guard, []
        if operator in {"contains", "notContains", "startsWith", "endsWith"}:
            needle = normalize_text(rule.get("value"))
            if needle == "":
                if operator == "notContains":
                    return "FALSE", []
                return guard, []
            if operator == "contains":
                return f"({guard} AND contains({column}, ?))", [needle]
            if operator == "notContains":
                return f"({guard} AND NOT contains({column}, ?))", [needle]
            if operator == "endsWith":
                return f"({guard} AND ends_with({column}, ?))", [needle]
            upper = needle + chr(0x10FFFF)
            return f"({guard} AND {column} >= ? AND {column} < ?)", [needle, upper]
        if operator in {"equals", "notEquals"}:
            needle = normalize_text(rule.get("value"))
            if needle == "":
                return ("FALSE", []) if operator == "equals" else (guard, [])
            comparison = "=" if operator == "equals" else "<>"
            return f"({guard} AND {column} {comparison} ?)", [needle]
        if operator in {
            "greaterThan",
            "greaterThanOrEqual",
            "lessThan",
            "lessThanOrEqual",
        }:
            needle = normalize_text(rule.get("value"))
            if needle == "":
                return "FALSE", []
            comparison = {
                "greaterThan": ">",
                "greaterThanOrEqual": ">=",
                "lessThan": "<",
                "lessThanOrEqual": "<=",
            }[operator]
            return f"({guard} AND {column} {comparison} ?)", [needle]
        if operator == "between":
            lower = normalize_text(rule.get("min")) if rule.get("min") not in (None, "") else ""
            upper = normalize_text(rule.get("max")) if rule.get("max") not in (None, "") else ""
            clauses = [guard]
            parameters = []
            if lower:
                clauses.append(f"{column} >= ?")
                parameters.append(lower)
            if upper:
                clauses.append(f"{column} <= ?")
                parameters.append(upper)
            if not parameters:
                return guard, []
            return "(" + " AND ".join(clauses) + ")", parameters
        if operator == "in":
            values = [normalize_text(value) for value in rule.get("values") or []]
            values = [value for value in values if value != ""]
            if not values:
                return "FALSE", []
            placeholders = ", ".join("?" for _ in values)
            return f"({guard} AND {column} IN ({placeholders}))", values
        return None

    return None


def _build_where_clause(
    variables: list[dict[str, Any]],
    rules: list[dict[str, Any]],
    match_mode: str,
    row_index_name: str,
) -> tuple[str, list[Any]] | None:
    variable_by_name = {variable["name"]: variable for variable in variables}
    norm_names = _aux_column_names(variables, row_index_name)
    clauses: list[str] = []
    parameters: list[Any] = []
    for rule in rules or []:
        variable = variable_by_name.get(rule.get("field"))
        if variable is None:
            return None
        translated = _rule_clause(variable, rule, norm_names)
        if translated is None:
            return None
        clause, clause_parameters = translated
        clauses.append(clause)
        parameters.extend(clause_parameters)
    if not clauses:
        return None
    joiner = " OR " if match_mode == "any" else " AND "
    return joiner.join(f"({clause})" for clause in clauses), parameters


def query_sav_cache(
    cache_path: str,
    variables: list[dict[str, Any]],
    row_index_name: str,
    rules: list[dict[str, Any]],
    match_mode: str,
    offset: int,
    limit: int,
    total: int | None = None,
) -> tuple[list[dict[str, Any]], int] | None:
    where = _build_where_clause(variables, rules, match_mode, row_index_name)
    if where is None:
        return None
    where_clause, parameters = where
    if limit <= 0:
        return [], int(total or 0)

    relation = _parquet_relation(cache_path)
    index_column = _quoted_identifier(row_index_name)
    connection = _read_connection()
    if total is None:
        total = int(
            connection.execute(
                f"SELECT COUNT(*) FROM {relation} WHERE {where_clause}",
                parameters,
            ).fetchone()[0]
        )
    if total <= 0 or offset >= total:
        return [], total

    names = [variable["name"] for variable in variables]
    selected = ", ".join(_quoted_identifier(name) for name in names)
    if selected:
        selected += ", "
    page_query = (
        "WITH matched AS ("
        f"SELECT {index_column} AS __matched_row FROM {relation} "
        f"WHERE {where_clause} ORDER BY {index_column} LIMIT ? OFFSET ?"
        ") "
        f"SELECT {selected}{index_column} FROM {relation} "
        f"WHERE {index_column} IN (SELECT __matched_row FROM matched) "
        f"ORDER BY {index_column}"
    )
    records = connection.execute(
        page_query,
        [*parameters, limit, offset],
    ).fetchall()
    label_maps = _cache_label_maps(variables)
    return [_serialize_cache_record(record, names, label_maps) for record in records], total


def _iter_records(
    query: str,
    parameters: list[Any],
    names: list[str],
    label_maps: dict[str, dict[Any, str]],
    chunk_size: int,
):
    cursor = _read_connection().execute(query, parameters)
    while records := cursor.fetchmany(chunk_size):
        for record in records:
            yield _serialize_cache_record(record, names, label_maps)


def iter_sav_cache_query(
    cache_path: str,
    variables: list[dict[str, Any]],
    row_index_name: str,
    rules: list[dict[str, Any]],
    match_mode: str = "all",
    chunk_size: int = 2000,
) -> Iterator[dict[str, Any]] | None:
    where = _build_where_clause(variables, rules, match_mode, row_index_name)
    if rules and where is None:
        return None

    names = [variable["name"] for variable in variables]
    selected = ", ".join(_quoted_identifier(name) for name in names)
    if selected:
        selected += ", "
    index_column = _quoted_identifier(row_index_name)
    relation = _parquet_relation(cache_path)
    where_sql = f" WHERE {where[0]}" if where else ""
    parameters = where[1] if where else []
    query = (
        f"SELECT {selected}{index_column} FROM {relation}{where_sql} "
        f"ORDER BY {index_column}"
    )
    label_maps = _cache_label_maps(variables)
    return _iter_records(query, parameters, names, label_maps, chunk_size)


def iter_json_rows(path: str):
    for row in _iter_json_array(path):
        yield {str(name): _json_value(value) for name, value in row.items()}


def iter_dataset_rows(
    path: str,
    file_name: str,
    variables: list[dict[str, Any]],
    chunk_size: int = 2000,
    cache_path: str | None = None,
    cache_row_index: str = "__sav_studio_row_index__",
    columns: list[str] | None = None,
):
    if file_name.lower().endswith(".json"):
        if columns is None:
            yield from iter_json_rows(path)
        else:
            for row in iter_json_rows(path):
                yield {name: row.get(name) for name in columns}
        return
    if cache_path and os.path.exists(cache_path):
        yield from _iter_sav_cache_rows(
            cache_path,
            variables,
            cache_row_index,
            columns=columns,
            chunk_size=chunk_size,
        )
        return
    yield from iter_sav_rows(path, variables, chunk_size)


def read_sav_dataset(
    path: str,
    file_name: str,
    dataset_id: str,
    max_rows: int,
    max_cells: int = 0,
) -> Dataset:
    _, file_meta = pyreadstat.read_sav(
        path,
        metadataonly=True,
        apply_value_formats=False,
        formats_as_category=False,
        user_missing=False,
    )
    source_row_count = int(getattr(file_meta, "number_rows", 0) or 0)
    column_count = int(
        getattr(file_meta, "number_columns", 0)
        or len(getattr(file_meta, "column_names", None) or [])
    )

    row_budget = max_rows
    if max_cells > 0 and column_count > 0:
        cell_budget = max(1, max_cells // column_count)
        row_budget = min(row_budget, cell_budget) if row_budget > 0 else cell_budget

    truncated = row_budget > 0 and source_row_count > row_budget

    df, meta = pyreadstat.read_sav(
        path,
        apply_value_formats=False,
        formats_as_category=False,
        user_missing=False,
        row_limit=row_budget if truncated else 0,
    )

    if source_row_count <= 0:
        source_row_count = int(len(df))
    warnings: list[str] = []
    if truncated:
        if max_rows > 0 and row_budget < max_rows:
            warnings.append(
                f"El archivo contiene {source_row_count:,} filas y {column_count:,} variables; "
                f"se cargaron {row_budget:,} filas como muestra inicial por el límite de "
                f"{max_cells:,} celdas. La tabla permite recorrer el archivo completo por páginas."
            )
        else:
            warnings.append(
                f"El archivo contiene {source_row_count:,} filas; se cargaron las primeras "
                f"{row_budget:,} para mantener la aplicación fluida."
            )

    column_names = list(getattr(meta, "column_names", None) or list(df.columns))
    column_labels = list(getattr(meta, "column_labels", None) or [])
    variable_value_labels = getattr(meta, "variable_value_labels", None) or {}
    original_types = getattr(meta, "original_variable_types", None) or {}
    variable_measure = getattr(meta, "variable_measure", None) or {}
    missing_ranges = getattr(meta, "missing_ranges", None) or {}
    display_widths = getattr(meta, "variable_display_width", None) or {}

    label_maps = {
        name: _normalize_label_map(variable_value_labels.get(name))
        for name in column_names
    }

    counts_by_variable: dict[str, Counter[Any]] = {
        name: Counter() for name in column_names
    }
    rows: list[dict[str, Any]] = []

    for record in df.itertuples(index=False, name=None):
        row: dict[str, Any] = {}
        for name, value in zip(column_names, record):
            serialized = _serialize_value(value, label_maps[name])
            row[name] = serialized
            counts_by_variable[name][serialized] += 1
        rows.append(row)

    variables: list[dict[str, Any]] = []
    for index, name in enumerate(column_names):
        series = df[name]
        spss_format = original_types.get(name)
        variable_type = _variable_type(series, spss_format)
        label = column_labels[index] if index < len(column_labels) else ""
        raw_labels = variable_value_labels.get(name)
        unique_count = int(series.nunique(dropna=True))
        counts = counts_by_variable[name]

        include_categories = bool(raw_labels) or unique_count <= 200
        categories = _categories_for(counts, raw_labels) if include_categories else []

        variables.append(
            {
                "name": name,
                "label": label or name,
                "type": variable_type,
                "spss_format": spss_format,
                "measure": variable_measure.get(name, "unknown"),
                "display_width": display_widths.get(name),
                "has_value_labels": bool(raw_labels),
                "value_labels": _label_map_for_json(raw_labels),
                "missing_ranges": _missing_ranges_for_json(missing_ranges.get(name)),
                "categories": categories,
                "stats": _stats_for(series, variable_type),
            }
        )

    return Dataset(
        id=dataset_id,
        file_name=file_name,
        created_at=unix_time(),
        variables=variables,
        rows=rows,
        source_row_count=source_row_count,
        truncated=truncated,
        warnings=warnings,
    )
