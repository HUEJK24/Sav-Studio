from __future__ import annotations

import csv
import io
import json
import re
from typing import Any, Callable, Iterator

from .filters import filter_rows
from .sav_reader import iter_dataset_rows
from .store import Dataset


def safe_base_name(name: str | None) -> str:
    cleaned = re.sub(r"\.(sav|zsav|json)$", "", name or "datos", flags=re.IGNORECASE)
    cleaned = re.sub(r"[^\w\-. ]+", "_", cleaned).strip()
    return cleaned or "datos"


def export_file_name(dataset: Dataset, extension: str) -> str:
    return f"{safe_base_name(dataset.file_name)}_filtrado.{extension}"


def _headers(variables: list[dict[str, Any]]) -> list[str]:
    used: dict[str, int] = {}
    headers: list[str] = []
    for variable in variables:
        header = variable.get("label") or variable.get("name")
        if header == variable.get("name"):
            header = variable.get("name")
        count = used.get(header, 0)
        used[header] = count + 1
        if count > 0:
            header = f"{header} ({variable.get('name')})"
        headers.append(header)
    return headers


def iter_filtered_rows(
    dataset: Dataset,
    rules: list[dict[str, Any]],
    match_mode: str = "all",
    progress_callback: Callable[[int], None] | None = None,
) -> Iterator[dict[str, Any]]:
    if dataset.server_paged:
        if not dataset.source_path:
            raise FileNotFoundError("El archivo original ya no está disponible.")
        source = iter_dataset_rows(
            dataset.source_path,
            dataset.file_name,
            dataset.variables,
            cache_path=dataset.cache_path,
            cache_row_index=dataset.cache_row_index,
        )
    else:
        source = iter(dataset.rows)

    def tracked_rows() -> Iterator[dict[str, Any]]:
        scanned = 0
        for row in source:
            scanned += 1
            if progress_callback and scanned % 1000 == 0:
                progress_callback(scanned)
            yield row
        if progress_callback:
            progress_callback(scanned)

    yield from filter_rows(tracked_rows(), rules, match_mode)


def _csv_cell(value: Any) -> Any:
    if value is None:
        return ""
    return value


def csv_chunks(
    dataset: Dataset,
    rules: list[dict[str, Any]],
    match_mode: str = "all",
    chunk_rows: int = 2000,
    progress_callback: Callable[[int], None] | None = None,
) -> Iterator[str]:
    names = [variable["name"] for variable in dataset.variables]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(_headers(dataset.variables))
    yield "\ufeff" + buffer.getvalue()
    buffer.seek(0)
    buffer.truncate(0)

    written = 0
    for row in iter_filtered_rows(dataset, rules, match_mode, progress_callback):
        writer.writerow([_csv_cell(row.get(name)) for name in names])
        written += 1
        if written % chunk_rows == 0:
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    if buffer.tell():
        yield buffer.getvalue()


def json_chunks(
    dataset: Dataset,
    rules: list[dict[str, Any]],
    match_mode: str = "all",
    progress_callback: Callable[[int], None] | None = None,
) -> Iterator[str]:
    yield "["
    first = True
    for row in iter_filtered_rows(dataset, rules, match_mode, progress_callback):
        if not first:
            yield ","
        serialized_row = json.dumps(row, ensure_ascii=False, default=str, indent=2)
        yield "\n" + "\n".join(
            f"  {line}" for line in serialized_row.splitlines()
        )
        first = False
    yield "\n]\n" if not first else "]\n"
