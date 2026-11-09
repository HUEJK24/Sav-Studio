from __future__ import annotations

import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from threading import Lock
from typing import Any

from .config import DATASET_TTL_SECONDS, FILTER_CACHE_ENTRIES, MAX_DATASETS
from .utils import remove_path


@dataclass
class Dataset:
    id: str
    file_name: str
    created_at: float
    variables: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    source_row_count: int
    truncated: bool
    warnings: list[str] = field(default_factory=list)
    source_path: str | None = None
    cache_path: str | None = None
    cache_row_index: str = "__sav_studio_row_index__"
    cache_building: bool = False
    cache_progress: int = 0
    cache_error: str | None = None
    filter_cache: OrderedDict[str, int] = field(default_factory=OrderedDict)

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def server_paged(self) -> bool:
        return self.truncated and bool(self.source_path)

    def get_filter_cache(self, key: str) -> int | None:
        total = self.filter_cache.get(key)
        if total is not None:
            self.filter_cache.move_to_end(key)
        return total

    def set_filter_cache(
        self,
        key: str,
        total: int,
        max_entries: int = FILTER_CACHE_ENTRIES,
    ) -> None:
        self.filter_cache[key] = total
        self.filter_cache.move_to_end(key)
        while len(self.filter_cache) > max_entries:
            self.filter_cache.popitem(last=False)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "file_name": self.file_name,
            "created_at": self.created_at,
            "row_count": self.row_count,
            "source_row_count": self.source_row_count,
            "column_count": len(self.variables),
            "truncated": self.truncated,
            "server_paged": self.server_paged,
            "cache_building": self.cache_building,
            "cache_progress": self.cache_progress,
            "cache_error": self.cache_error,
            "warnings": self.warnings,
            "variables": self.variables,
        }

    def payload(self, include_rows: bool = True) -> dict[str, Any]:
        data = self.summary()
        data["rows"] = self.rows if include_rows else []
        return data


class DatasetStore:
    def __init__(self, max_datasets: int, ttl_seconds: int) -> None:
        self._max_datasets = max_datasets
        self._ttl_seconds = ttl_seconds
        self._items: OrderedDict[str, Dataset] = OrderedDict()
        self._lock = Lock()

    def add(self, dataset: Dataset) -> None:
        with self._lock:
            self._evict_expired()
            self._items[dataset.id] = dataset
            self._items.move_to_end(dataset.id)
            while len(self._items) > self._max_datasets:
                _, evicted = self._items.popitem(last=False)
                self._remove_source(evicted)

    def get(self, dataset_id: str) -> Dataset | None:
        with self._lock:
            self._evict_expired()
            dataset = self._items.get(dataset_id)
            if dataset is not None:
                self._items.move_to_end(dataset_id)
            return dataset

    def delete(self, dataset_id: str) -> bool:
        with self._lock:
            dataset = self._items.pop(dataset_id, None)
            if dataset is None:
                return False
            self._remove_source(dataset)
            return True

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [
            dataset_id
            for dataset_id, dataset in self._items.items()
            if now - dataset.created_at > self._ttl_seconds
        ]
        for dataset_id in expired:
            dataset = self._items.pop(dataset_id, None)
            if dataset is not None:
                self._remove_source(dataset)

    @staticmethod
    def _remove_source(dataset: Dataset) -> None:
        remove_path(dataset.cache_path)
        remove_path(dataset.source_path)

    def new_id(self) -> str:
        return uuid.uuid4().hex


store = DatasetStore(max_datasets=MAX_DATASETS, ttl_seconds=DATASET_TTL_SECONDS)
