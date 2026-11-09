from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pyreadstat
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .config import (
    ALLOWED_EXTENSIONS,
    CORS_ORIGINS,
    MAX_CELLS,
    MAX_ROWS,
    MAX_UPLOAD_BYTES,
)
from .exporters import (
    csv_chunks,
    export_file_name,
    json_chunks,
)
from .filters import build_predicate, filter_signature, rule_is_active
from .sav_reader import (
    build_sav_cache,
    iter_dataset_rows,
    read_dataset,
    read_dataset_rows,
    read_sav_cache_indices,
    query_sav_cache,
)
from .store import store
from .utils import path_has_files, remove_path

logger = logging.getLogger("sav_studio")
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="SAV Studio API",
    description="Explorador de archivos SPSS (.sav/.zsav) y datos JSON exportados.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Export-Progress-Id"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)

_export_progress: dict[str, dict[str, Any]] = {}
_export_progress_lock = threading.Lock()
_EXPORT_PROGRESS_TTL = 900


class FilterRequest(BaseModel):
    rules: list[dict[str, Any]] = []
    matchMode: str = "all"


class QueryRequest(FilterRequest):
    offset: int = 0
    limit: int = 100


class ExportRequest(FilterRequest):
    format: str = "csv"


def _get_dataset_or_404(dataset_id: str):
    dataset = store.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset no encontrado o expirado.")
    return dataset


def _require_source(dataset) -> None:
    if not dataset.source_path or not os.path.exists(dataset.source_path):
        raise HTTPException(
            status_code=409,
            detail="El archivo original ya no está disponible. Vuelve a cargar el .sav.",
        )


def _build_cache_for_dataset(dataset) -> None:
    if not dataset.source_path or not os.path.exists(dataset.source_path):
        dataset.cache_building = False
        dataset.cache_error = "El archivo original ya no está disponible."
        return

    cache_path = f"{dataset.source_path}.cache"
    try:
        row_index = build_sav_cache(
            dataset.source_path,
            cache_path,
            dataset.variables,
            progress_callback=lambda completed: setattr(
                dataset,
                "cache_progress",
                min(99, int(completed * 100 / dataset.source_row_count)),
            ),
        )
    except Exception:
        logger.exception("No se pudo crear la caché Parquet para %s", dataset.file_name)
        dataset.cache_building = False
        dataset.cache_error = (
            "No se pudo preparar la caché local. La paginación seguirá leyendo el SAV original."
        )
        remove_path(cache_path)
        if store.get(dataset.id) is not dataset:
            remove_path(dataset.source_path)
        return

    if store.get(dataset.id) is not dataset:
        remove_path(cache_path)
        remove_path(dataset.source_path)
        return

    dataset.cache_path = cache_path
    dataset.cache_row_index = row_index
    dataset.cache_progress = 100
    dataset.cache_building = False
    logger.info("Caché Parquet lista para %s", dataset.file_name)


def _source_rows(dataset, columns: list[str] | None = None):
    if dataset.server_paged:
        return iter_dataset_rows(
            dataset.source_path,
            dataset.file_name,
            dataset.variables,
            cache_path=dataset.cache_path,
            cache_row_index=dataset.cache_row_index,
            columns=columns,
        )
    return iter(dataset.rows)


def _filter_fields(dataset, rules: list[dict[str, Any]]) -> list[str]:
    available = {variable["name"] for variable in dataset.variables}
    return list(
        dict.fromkeys(
            rule["field"]
            for rule in rules or []
            if isinstance(rule.get("field"), str)
            and rule["field"] in available
        )
    )


def _rows_for_indices(dataset, indices: list[int]) -> list[dict[str, Any]]:
    if not indices:
        return []
    if not dataset.server_paged:
        return [dataset.rows[index] for index in indices]
    if path_has_files(dataset.cache_path):
        return read_sav_cache_indices(
            dataset.cache_path,
            dataset.variables,
            dataset.cache_row_index,
            indices,
        )

    first, last = indices[0], indices[-1]
    span = last - first + 1
    if span <= max(5000, len(indices) * 50):
        block = read_dataset_rows(
            dataset.source_path,
            dataset.file_name,
            first,
            span,
            dataset.variables,
            dataset.cache_path,
            dataset.cache_row_index,
        )
        return [block[index - first] for index in indices if 0 <= index - first < len(block)]

    wanted = set(indices)
    result: list[dict[str, Any]] = []
    for position, row in enumerate(_source_rows(dataset)):
        if position > last:
            break
        if position in wanted:
            result.append(row)
    return result


def _stream_page(
    dataset,
    predicate,
    offset: int,
    limit: int,
    rules: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    result: list[dict[str, Any]] = []
    positions: list[int] = []
    use_cache = path_has_files(dataset.cache_path)
    source = _source_rows(dataset, _filter_fields(dataset, rules)) if use_cache else _source_rows(dataset)
    matched = 0
    for position, row in enumerate(source):
        if predicate is None or predicate(row):
            if matched >= offset:
                if use_cache:
                    positions.append(position)
                else:
                    result.append(row)
                if len(result) + len(positions) >= limit:
                    break
            matched += 1
    if use_cache:
        return _rows_for_indices(dataset, positions)
    return result


def _filtered_page(
    dataset,
    rules: list[dict[str, Any]],
    match_mode: str,
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], int]:
    offset = max(0, offset)
    limit = max(0, min(limit, 500))
    predicate = build_predicate(rules, match_mode)

    if predicate is None:
        if dataset.server_paged:
            _require_source(dataset)
            rows = read_dataset_rows(
                dataset.source_path,
                dataset.file_name,
                offset,
                limit,
                dataset.variables,
                dataset.cache_path,
                dataset.cache_row_index,
            )
            return rows, dataset.source_row_count
        return dataset.rows[offset : offset + limit], dataset.row_count

    key = filter_signature(rules, match_mode)
    cached_total = dataset.get_filter_cache(key)
    if path_has_files(dataset.cache_path):
        indexed_result = query_sav_cache(
            dataset.cache_path,
            dataset.variables,
            dataset.cache_row_index,
            [rule for rule in rules or [] if rule_is_active(rule)],
            match_mode,
            offset,
            limit,
            total=cached_total,
        )
        if indexed_result is not None:
            page, total = indexed_result
            dataset.set_filter_cache(key, total)
            return page, total

    if cached_total is not None:
        return _stream_page(dataset, predicate, offset, limit, rules), cached_total

    if dataset.server_paged:
        _require_source(dataset)

    total = 0
    page: list[dict[str, Any]] = []
    page_indices: list[int] = []
    use_cache = path_has_files(dataset.cache_path)
    source = _source_rows(dataset, _filter_fields(dataset, rules)) if use_cache else _source_rows(dataset)

    for position, row in enumerate(source):
        if not predicate(row):
            continue
        if offset <= total < offset + limit:
            if use_cache:
                page_indices.append(position)
            else:
                page.append(row)
        total += 1

    dataset.set_filter_cache(key, total)
    if use_cache:
        page = _rows_for_indices(dataset, page_indices)
    return page, total


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "SAV Studio API",
        "docs": "/docs",
        "health": "/api/health",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "sav-studio",
        "pyreadstat": getattr(pyreadstat, "__version__", "desconocida"),
    }


@app.post("/api/datasets")
async def upload_dataset(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> dict:
    original_name = Path(file.filename or "datos.sav").name
    suffix = Path(original_name).suffix.lower()

    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=            "Formato no admitido. Sube un archivo .sav, .zsav o un JSON exportado como lista de filas.",
        )

    temp_path = ""
    size = 0
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            "El archivo supera el límite de "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                        ),
                    )
                temp_file.write(chunk)

        if size == 0:
            raise HTTPException(status_code=400, detail="El archivo está vacío.")

        dataset_id = store.new_id()
        dataset = await run_in_threadpool(
            read_dataset,
            path=temp_path,
            file_name=original_name,
            dataset_id=dataset_id,
            max_rows=MAX_ROWS,
            max_cells=MAX_CELLS,
        )
        dataset.source_path = temp_path
        if dataset.server_paged and suffix != ".json":
            dataset.cache_building = True
        temp_path = ""
        store.add(dataset)
        if dataset.cache_building:
            background_tasks.add_task(_build_cache_for_dataset, dataset)
            logger.info("Indexación DuckDB en segundo plano iniciada para %s", original_name)
        logger.info(
            "Dataset %s cargado: %s filas, %s variables",
            dataset.id,
            dataset.row_count,
            len(dataset.variables),
        )
        return dataset.payload(include_rows=True)

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Error leyendo archivo SPSS")
        raise HTTPException(
            status_code=422,
            detail=(
                "No se pudo leer el archivo SPSS. Verifica que sea un .sav/.zsav "
                f"válido y que no esté dañado. Detalle: {exc}"
            ),
        ) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                logger.warning("No se pudo eliminar el archivo temporal %s", temp_path)
@app.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> dict:
    dataset = store.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset no encontrado o expirado.")
    return dataset.payload(include_rows=False)


@app.get("/api/datasets/{dataset_id}/status")
def get_dataset_status(dataset_id: str) -> dict[str, Any]:
    dataset = store.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset no encontrado o expirado.")
    return {
        "id": dataset.id,
        "cache_building": dataset.cache_building,
        "cache_progress": dataset.cache_progress,
        "cache_error": dataset.cache_error,
    }


@app.post("/api/datasets/{dataset_id}/reload")
def reload_dataset(dataset_id: str) -> dict:
    dataset = store.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset no encontrado o expirado.")
    if not dataset.source_path or not os.path.exists(dataset.source_path):
        raise HTTPException(
            status_code=409,
            detail="El archivo original ya no está disponible. Vuelve a cargar el .sav.",
        )

    try:
        reloaded = read_dataset(
            path=dataset.source_path,
            file_name=dataset.file_name,
            dataset_id=dataset.id,
            max_rows=MAX_ROWS,
            max_cells=MAX_CELLS,
        )
    except Exception as exc:
        logger.exception("Error reprocesando archivo SPSS")
        raise HTTPException(
            status_code=422,
            detail=f"No se pudo reprocesar el archivo SPSS. Detalle: {exc}",
        ) from exc

    reloaded.source_path = dataset.source_path
    reloaded.cache_path = dataset.cache_path
    reloaded.cache_row_index = dataset.cache_row_index
    store.add(reloaded)
    logger.info(
        "Dataset %s reprocesado: %s filas, %s variables",
        reloaded.id,
        reloaded.row_count,
        len(reloaded.variables),
    )
    return reloaded.payload(include_rows=True)


@app.get("/api/datasets/{dataset_id}/rows")
def get_dataset_rows(
    dataset_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    dataset = store.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset no encontrado o expirado.")

    total = dataset.source_row_count if dataset.server_paged else dataset.row_count
    if dataset.server_paged and dataset.cache_building:
        if offset >= dataset.row_count:
            raise HTTPException(
                status_code=409,
                detail="La caché local sigue preparándose. Espera a que termine la indexación.",
            )
        rows = dataset.rows[offset : min(offset + limit, dataset.row_count)]
    elif dataset.server_paged:
        if not dataset.source_path or not os.path.exists(dataset.source_path):
            raise HTTPException(
                status_code=409,
                detail="El archivo original ya no está disponible. Vuelve a cargar el .sav.",
            )
        try:
            rows = read_dataset_rows(
                dataset.source_path,
                dataset.file_name,
                offset,
                limit,
                dataset.variables,
                dataset.cache_path,
                dataset.cache_row_index,
            )
        except Exception as exc:
            logger.exception("Error leyendo una página del archivo SPSS")
            raise HTTPException(
                status_code=422,
                detail=f"No se pudo leer esta página del archivo SPSS. Detalle: {exc}",
            ) from exc
    else:
        rows = dataset.rows[offset : offset + limit]

    return {
        "rows": rows,
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@app.post("/api/datasets/{dataset_id}/query")
def query_dataset(dataset_id: str, request: QueryRequest) -> dict:
    dataset = _get_dataset_or_404(dataset_id)
    if dataset.cache_building and build_predicate(request.rules, request.matchMode):
        raise HTTPException(
            status_code=409,
            detail="Los filtros de archivo completo estarán disponibles al terminar la indexación local.",
        )
    if dataset.server_paged:
        _require_source(dataset)

    try:
        rows, total = _filtered_page(
            dataset,
            request.rules,
            request.matchMode,
            request.offset,
            request.limit,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Error filtrando el dataset %s", dataset_id)
        raise HTTPException(
            status_code=422,
            detail=f"No se pudieron aplicar los filtros al archivo. Detalle: {exc}",
        ) from exc

    return {
        "rows": rows,
        "total": total,
        "offset": request.offset,
        "limit": request.limit,
        "filtered": bool(request.rules),
    }


def _attachment_headers(file_name: str) -> dict[str, str]:
    ascii_name = file_name.encode("ascii", "ignore").decode() or "export"
    return {
        "Content-Disposition": (
            f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(file_name)}"
        )
    }


def _update_export_progress(
    export_id: str,
    *,
    completed: int | None = None,
    done: bool = False,
    error: str | None = None,
) -> None:
    with _export_progress_lock:
        progress = _export_progress.get(export_id)
        if progress is None:
            return
        if completed is not None:
            progress["completed"] = completed
            progress["percent"] = min(
                99, round(completed * 100 / progress["total"])
            ) if progress["total"] else 99
        if done:
            progress["done"] = True
            progress["percent"] = 100 if error is None else progress["percent"]
        if error is not None:
            progress["error"] = error
        progress["updated_at"] = time.time()


@app.get("/api/exports/{export_id}/status")
def get_export_progress(export_id: str) -> dict[str, Any]:
    now = time.time()
    with _export_progress_lock:
        expired = [
            key
            for key, value in _export_progress.items()
            if now - value["updated_at"] > _EXPORT_PROGRESS_TTL
        ]
        for key in expired:
            del _export_progress[key]
        progress = _export_progress.get(export_id)
        if progress is None:
            raise HTTPException(status_code=404, detail="Exportación no encontrada o expirada.")
        return {
            "percent": progress["percent"],
            "completed": progress["completed"],
            "total": progress["total"],
            "done": progress["done"],
            "error": progress["error"],
        }


@app.post("/api/datasets/{dataset_id}/export")
def export_dataset(dataset_id: str, request: ExportRequest) -> StreamingResponse:
    dataset = _get_dataset_or_404(dataset_id)
    export_format = request.format.lower().strip()
    if export_format not in {"csv", "json"}:
        raise HTTPException(
            status_code=400,
            detail="Formato no admitido. Usa 'csv' o 'json'.",
        )
    if dataset.server_paged:
        _require_source(dataset)
    if dataset.cache_building:
        raise HTTPException(
            status_code=409,
            detail="La exportación estará disponible al terminar la indexación local.",
        )

    file_name = export_file_name(dataset, export_format)
    headers = _attachment_headers(file_name)
    export_id = uuid.uuid4().hex
    with _export_progress_lock:
        now = time.time()
        expired = [
            key
            for key, value in _export_progress.items()
            if now - value["updated_at"] > _EXPORT_PROGRESS_TTL
        ]
        for key in expired:
            del _export_progress[key]
        _export_progress[export_id] = {
            "percent": 0,
            "completed": 0,
            "total": dataset.source_row_count,
            "done": False,
            "error": None,
            "updated_at": now,
        }

    def tracked_chunks(chunks):
        try:
            yield from chunks(
                dataset,
                request.rules,
                request.matchMode,
                progress_callback=lambda completed: _update_export_progress(
                    export_id, completed=completed
                ),
            )
        except Exception:
            logger.exception("No se pudo completar la exportación de %s", dataset.file_name)
            _update_export_progress(
                export_id,
                done=True,
                error="Ocurrió un error al generar el archivo. Intenta exportarlo de nuevo.",
            )
            raise
        else:
            _update_export_progress(export_id, done=True)

    headers["X-Export-Progress-Id"] = export_id
    if export_format == "csv":
        return StreamingResponse(
            tracked_chunks(csv_chunks),
            media_type="text/csv; charset=utf-8",
            headers=headers,
        )

    return StreamingResponse(
        tracked_chunks(json_chunks),
        media_type="application/json; charset=utf-8",
        headers=headers,
    )


@app.delete("/api/datasets/{dataset_id}")
def delete_dataset(dataset_id: str) -> dict[str, bool]:
    deleted = store.delete(dataset_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Dataset no encontrado o expirado.")
    return {"deleted": True}
