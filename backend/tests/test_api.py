from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pyreadstat
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.store import store
from app.sav_reader import (
    build_sav_cache,
    read_json_dataset,
    read_json_rows,
    read_sav_dataset,
    read_sav_rows,
    read_dataset_rows,
    query_sav_cache,
)


@pytest.fixture()
def sample_sav(tmp_path):
    path = tmp_path / "encuesta.sav"
    df = pd.DataFrame(
        {
            "id": [1.0, 2.0, 3.0, 4.0],
            "gender": [1.0, 2.0, 1.0, np.nan],
            "age": [15.0, 16.0, 17.0, 18.0],
            "name": ["Ana", "Luis", "Eva", "Jon"],
        }
    )
    pyreadstat.write_sav(
        df,
        str(path),
        column_labels=["ID", "Género", "Edad", "Nombre"],
        variable_value_labels={"gender": {1.0: "Femenino", 2.0: "Masculino"}},
        variable_measure={
            "id": "nominal",
            "gender": "nominal",
            "age": "scale",
            "name": "nominal",
        },
    )
    return path


@pytest.fixture()
def client():
    return TestClient(app)


def upload(client: TestClient, path, name: str = "encuesta.sav"):
    with path.open("rb") as handle:
        return client.post(
            "/api/datasets",
            files={"file": (name, handle, "application/octet-stream")},
        )


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.parametrize("export_format", ["csv", "json"])
def test_export_reports_row_progress(client, sample_sav, export_format):
    uploaded = upload(client, sample_sav)
    dataset_id = uploaded.json()["id"]
    try:
        response = client.post(
            f"/api/datasets/{dataset_id}/export",
            json={"format": export_format},
        )
        assert response.status_code == 200

        export_id = response.headers["X-Export-Progress-Id"]
        progress = client.get(f"/api/exports/{export_id}/status")

        assert progress.status_code == 200
        assert progress.json() == {
            "percent": 100,
            "completed": 4,
            "total": 4,
            "done": True,
            "error": None,
        }
        if export_format == "json":
            assert len(response.json()) == 4
        else:
            assert "ID" in response.text
    finally:
        client.delete(f"/api/datasets/{dataset_id}")


def test_upload_preserves_labels_and_metadata(client, sample_sav):
    response = upload(client, sample_sav)
    assert response.status_code == 200

    payload = response.json()
    assert payload["row_count"] == 4
    assert payload["column_count"] == 4
    assert payload["rows"][0]["gender"] == "Femenino"
    assert payload["rows"][3]["gender"] is None

    variables = {variable["name"]: variable for variable in payload["variables"]}
    assert variables["gender"]["has_value_labels"] is True
    assert variables["gender"]["label"] == "Género"
    assert variables["gender"]["value_labels"] == {
        "1": "Femenino",
        "2": "Masculino",
    }
    assert variables["age"]["type"] == "numeric"
    assert variables["age"]["stats"]["max"] == 18
    assert variables["name"]["type"] == "string"

    dataset_id = payload["id"]
    metadata = client.get(f"/api/datasets/{dataset_id}")
    assert metadata.status_code == 200
    assert metadata.json()["rows"] == []

    page = client.get(f"/api/datasets/{dataset_id}/rows?offset=1&limit=2")
    assert page.status_code == 200
    assert page.json()["total"] == 4
    assert [row["id"] for row in page.json()["rows"]] == [2, 3]

    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200
    assert client.get(f"/api/datasets/{dataset_id}").status_code == 404


def test_dataset_status_returns_only_indexing_progress(client, sample_sav, monkeypatch):
    monkeypatch.setattr("app.main.MAX_CELLS", 8)
    monkeypatch.setattr("app.main._build_cache_for_dataset", lambda dataset: None)
    response = upload(client, sample_sav)
    assert response.status_code == 200
    dataset_id = response.json()["id"]

    status = client.get(f"/api/datasets/{dataset_id}/status")
    assert status.status_code == 200
    assert status.json() == {
        "id": dataset_id,
        "cache_building": True,
        "cache_progress": 0,
        "cache_error": None,
    }

    client.delete(f"/api/datasets/{dataset_id}")


def test_read_sav_truncates_to_max_rows(sample_sav):
    dataset = read_sav_dataset(str(sample_sav), "encuesta.sav", "test", 2)

    assert dataset.source_row_count == 4
    assert dataset.row_count == 2
    assert dataset.truncated is True
    assert len(dataset.warnings) == 1


def test_read_sav_respects_cell_budget(sample_sav):
    dataset = read_sav_dataset(str(sample_sav), "encuesta.sav", "test", 200000, 8)

    assert dataset.source_row_count == 4
    assert dataset.row_count == 2
    assert dataset.truncated is True
    assert "8 celdas" in dataset.warnings[0]


def test_read_sav_rows_reads_arbitrary_page_with_value_labels(sample_sav):
    dataset = read_sav_dataset(str(sample_sav), "encuesta.sav", "test", 2)

    rows = read_sav_rows(
        str(sample_sav),
        2,
        2,
        dataset.variables,
    )

    assert [row["id"] for row in rows] == [3, 4]
    assert rows[0]["gender"] == "Femenino"
    assert rows[1]["gender"] is None


def test_sav_cache_reads_labeled_pages_across_chunks(sample_sav, tmp_path):
    dataset = read_sav_dataset(str(sample_sav), "encuesta.sav", "test", 2)
    cache_path = str(tmp_path / "encuesta.duckdb")
    progress = []
    row_index_name = build_sav_cache(
        str(sample_sav),
        cache_path,
        dataset.variables,
        chunk_size=2,
        progress_callback=progress.append,
    )

    rows = read_dataset_rows(
        str(sample_sav),
        "encuesta.sav",
        1,
        2,
        dataset.variables,
        cache_path,
        row_index_name,
    )

    assert [row["id"] for row in rows] == [2, 3]
    assert [row["gender"] for row in rows] == ["Masculino", "Femenino"]
    assert progress[-1] == 4


def test_sav_cache_filters_categorical_prefix_in_duckdb(sample_sav, tmp_path):
    dataset = read_sav_dataset(str(sample_sav), "encuesta.sav", "test", 4)
    gender = next(variable for variable in dataset.variables if variable["name"] == "gender")
    gender["value_labels"] = {"1": "México", "2": "Argentina"}
    cache_path = str(tmp_path / "encuesta.duckdb")
    row_index_name = build_sav_cache(
        str(sample_sav),
        cache_path,
        dataset.variables,
        chunk_size=2,
    )

    rule = {
        "field": "gender",
        "kind": "categorical",
        "operator": "startsWith",
        "value": "me",
    }
    rows, total = query_sav_cache(
        cache_path, dataset.variables, row_index_name, [rule], "all", 0, 10
    )
    assert total == 2
    assert [row["id"] for row in rows] == [1, 3]

    rule["value"] = "mex"
    rows, total = query_sav_cache(
        cache_path, dataset.variables, row_index_name, [rule], "all", 0, 10
    )

    assert total == 2
    assert [row["id"] for row in rows] == [1, 3]
    assert rows[0]["gender"] == "México"


def test_query_endpoint_uses_cached_text_prefix_filter(client, sample_sav, tmp_path):
    dataset = read_sav_dataset(str(sample_sav), "encuesta.sav", "prefix-query", 2)
    dataset.source_path = str(sample_sav)
    dataset.cache_path = str(tmp_path / "encuesta.duckdb")
    dataset.cache_row_index = build_sav_cache(
        str(sample_sav),
        dataset.cache_path,
        dataset.variables,
        chunk_size=2,
    )
    store.add(dataset)
    try:
        response = client.post(
            f"/api/datasets/{dataset.id}/query",
            json={
                "rules": [
                    {
                        "field": "gender",
                        "kind": "categorical",
                        "operator": "startsWith",
                        "value": "mas",
                    }
                ],
                "matchMode": "all",
                "offset": 0,
                "limit": 10,
            },
        )
    finally:
        client.delete(f"/api/datasets/{dataset.id}")

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [row["id"] for row in response.json()["rows"]] == [2]


def test_truncated_upload_exposes_remaining_rows_through_api(client, sample_sav, monkeypatch):
    monkeypatch.setattr("app.main.MAX_CELLS", 8)
    response = upload(client, sample_sav)

    assert response.status_code == 200
    payload = response.json()
    assert payload["server_paged"] is True
    assert payload["row_count"] == 2

    page = client.get(
        f"/api/datasets/{payload['id']}/rows",
        params={"offset": 2, "limit": 2},
    )
    assert page.status_code == 200
    assert page.json()["total"] == 4
    assert [row["id"] for row in page.json()["rows"]] == [3, 4]
    assert client.delete(f"/api/datasets/{payload['id']}").status_code == 200


def test_uploads_exported_json_rows(client, tmp_path):
    path = tmp_path / "datos.json"
    path.write_text(
        '[{"id": 1, "respuesta": "Sí"}, {"id": 2, "respuesta": "No"}]',
        encoding="utf-8",
    )

    response = upload(client, path, name="datos.json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_row_count"] == 2
    assert payload["column_count"] == 2
    assert payload["rows"][0] == {"id": 1, "respuesta": "Sí"}
    assert client.delete(f"/api/datasets/{payload['id']}").status_code == 200


def test_truncated_json_can_be_read_by_pages(tmp_path):
    path = tmp_path / "datos.json"
    path.write_text('[{"id": 1}, {"id": 2}, {"id": 3}]', encoding="utf-8")
    dataset = read_json_dataset(str(path), "datos.json", "test", 1)

    assert dataset.truncated is True
    assert read_json_rows(str(path), 2, 1) == [{"id": 3}]


def test_json_reader_streams_large_rows_and_late_columns(tmp_path):
    path = tmp_path / "datos.json"
    rows = [
        {"id": 1, "texto": "a" * 70_000},
        {"id": 2, "columna_tardia": "valor"},
        {"id": 3, "columna_tardia": "otro"},
    ]
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    dataset = read_json_dataset(str(path), "datos.json", "test", 20, 2)

    assert dataset.source_row_count == 3
    assert dataset.truncated is True
    assert dataset.row_count == 1
    assert dataset.rows[0]["id"] == 1
    assert dataset.rows[0]["columna_tardia"] is None
    assert read_json_rows(str(path), 2, 1) == [
        {"id": 3, "columna_tardia": "otro"}
    ]


def test_rejects_json_that_is_not_a_list_of_rows(client, tmp_path):
    path = tmp_path / "datos.json"
    path.write_text('{"not": "rows"}', encoding="utf-8")

    response = upload(client, path, name="datos.json")

    assert response.status_code == 422


def test_rejects_invalid_extension(client, tmp_path):
    path = tmp_path / "datos.csv"
    path.write_text("a,b\n1,2", encoding="utf-8")
    response = upload(client, path, name="datos.csv")
    assert response.status_code == 400


def test_rejects_empty_file(client, tmp_path):
    path = tmp_path / "vacio.sav"
    path.write_bytes(b"")
    response = upload(client, path, name="vacio.sav")
    assert response.status_code == 400
def test_rejects_corrupt_file(client, tmp_path):
    path = tmp_path / "roto.sav"
    path.write_bytes(b"esto no es un archivo spss")

    response = upload(client, path, name="roto.sav")

    assert response.status_code == 422


def test_query_filters_all_rows_of_paged_dataset(client, sample_sav, monkeypatch):
    monkeypatch.setattr("app.main.MAX_CELLS", 8)
    response = upload(client, sample_sav)
    assert response.status_code == 200
    dataset_id = response.json()["id"]

    body = {
        "rules": [
            {
                "field": "gender",
                "kind": "categorical",
                "operator": "in",
                "values": ["Femenino"],
            }
        ],
        "matchMode": "all",
        "offset": 0,
        "limit": 10,
    }
    filtered = client.post(f"/api/datasets/{dataset_id}/query", json=body)
    assert filtered.status_code == 200
    payload = filtered.json()
    assert payload["total"] == 2
    assert [row["id"] for row in payload["rows"]] == [1, 3]
    assert payload["rows"][0]["gender"] == "Femenino"

    second_body = {**body, "offset": 1, "limit": 1}
    second = client.post(f"/api/datasets/{dataset_id}/query", json=second_body)
    assert second.status_code == 200
    assert second.json()["total"] == 2
    assert [row["id"] for row in second.json()["rows"]] == [3]

    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200


def test_query_supports_numeric_and_null_filters(client, sample_sav):
    response = upload(client, sample_sav)
    dataset_id = response.json()["id"]

    body = {
        "rules": [
            {"field": "age", "kind": "numeric", "operator": "greaterThan", "value": "16"}
        ],
        "matchMode": "all",
        "offset": 0,
        "limit": 10,
    }
    payload = client.post(f"/api/datasets/{dataset_id}/query", json=body).json()
    assert payload["total"] == 2
    assert [row["id"] for row in payload["rows"]] == [3, 4]

    null_body = {
        "rules": [{"field": "gender", "kind": "categorical", "operator": "isNull"}],
        "matchMode": "all",
        "offset": 0,
        "limit": 10,
    }
    nulls = client.post(f"/api/datasets/{dataset_id}/query", json=null_body).json()
    assert nulls["total"] == 1
    assert [row["id"] for row in nulls["rows"]] == [4]

    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200


def test_query_filters_all_paged_rows_when_category_case_or_spacing_differs(
    client, tmp_path, monkeypatch
):
    monkeypatch.setattr("app.main.MAX_CELLS", 1)
    path = tmp_path / "paises.json"
    rows = [{"id": index, "pais": "Mexico"} for index in range(429)]
    rows.extend([{"id": 429, "pais": " MEXICO "}, {"id": 430, "pais": "Brasil"}])
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    response = upload(client, path, name="paises.json")
    assert response.json()["server_paged"] is True
    dataset_id = response.json()["id"]

    filtered = client.post(
        f"/api/datasets/{dataset_id}/query",
        json={
            "rules": [
                {
                    "field": "pais",
                    "kind": "categorical",
                    "operator": "in",
                    "values": ["Mexico"],
                }
            ],
            "offset": 0,
            "limit": 10,
        },
    )

    assert filtered.status_code == 200
    assert filtered.json()["total"] == 430
    assert len(filtered.json()["rows"]) == 10

    exported = client.post(
        f"/api/datasets/{dataset_id}/export",
        json={
            "format": "json",
            "rules": [
                {
                    "field": "pais",
                    "kind": "categorical",
                    "operator": "in",
                    "values": ["Mexico"],
                }
            ],
        },
    )
    assert exported.status_code == 200
    exported_rows = exported.json()
    assert len(exported_rows) == 430
    assert {row["id"] for row in exported_rows} == set(range(430))
    assert all(row["pais"].strip().casefold() == "mexico" for row in exported_rows)
    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200


def test_export_filtered_csv_and_json(client, sample_sav, monkeypatch):
    monkeypatch.setattr("app.main.MAX_CELLS", 8)
    response = upload(client, sample_sav)
    dataset_id = response.json()["id"]

    rules = [
        {
            "field": "gender",
            "kind": "categorical",
            "operator": "in",
            "values": ["Femenino"],
        }
    ]

    csv_response = client.post(
        f"/api/datasets/{dataset_id}/export",
        json={"format": "csv", "rules": rules, "matchMode": "all"},
    )
    assert csv_response.status_code == 200
    assert "text/csv" in csv_response.headers["content-type"]
    csv_text = csv_response.content.decode("utf-8-sig")
    lines = [line for line in csv_text.splitlines() if line.strip()]
    assert len(lines) == 3
    assert "Género" in lines[0]
    assert "Luis" not in csv_text
    assert "Ana" in csv_text
    assert "Eva" in csv_text

    json_response = client.post(
        f"/api/datasets/{dataset_id}/export",
        json={"format": "json", "rules": rules, "matchMode": "all"},
    )
    assert json_response.status_code == 200
    exported = json_response.json()
    assert [row["id"] for row in exported] == [1, 3]
    assert exported[0]["gender"] == "Femenino"
    assert json_response.text.startswith('[\n  {\n')
    assert json_response.text.endswith('\n]\n')

    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200
