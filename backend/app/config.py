import os

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "5120")) * 1024 * 1024
MAX_ROWS = int(os.getenv("MAX_ROWS", "200000"))
MAX_CELLS = int(os.getenv("MAX_CELLS", "50000"))
MAX_DATASETS = int(os.getenv("MAX_DATASETS", "2"))
DATASET_TTL_SECONDS = int(os.getenv("DATASET_TTL_SECONDS", "7200"))
ALLOWED_EXTENSIONS = {".sav", ".zsav", ".json"}

CACHE_CHUNK_ROWS = int(os.getenv("CACHE_CHUNK_ROWS", "10000"))
CACHE_COMPRESSION = os.getenv("CACHE_COMPRESSION", "zstd").strip().lower() or "zstd"
CACHE_ROW_GROUP_SIZE = int(os.getenv("CACHE_ROW_GROUP_SIZE", "122880"))
FILTER_CACHE_ENTRIES = int(os.getenv("FILTER_CACHE_ENTRIES", "8"))

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
