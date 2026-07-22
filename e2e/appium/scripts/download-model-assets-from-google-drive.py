#!/usr/bin/env python3
"""Download and extract the benchmark model asset bundle from Google Drive."""

from __future__ import annotations

import argparse
import io
import json
import os
import tarfile
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file-id", default=os.getenv("GOOGLE_DRIVE_MODEL_ASSET_BUNDLE_ID"))
    parser.add_argument("--output-dir", type=Path, default=Path("benchmark/app/assets"))
    return parser.parse_args()


def service_account_info() -> dict[str, Any] | None:
    json_value = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
    if json_value:
        return json.loads(json_value)

    json_path = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_FILE")
    if json_path:
        return json.loads(Path(json_path).read_text())

    return None


def build_drive_service():
    info = service_account_info()
    if not info:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is required for Drive model download.")

    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    credentials = service_account.Credentials.from_service_account_info(
        info,
        scopes=["https://www.googleapis.com/auth/drive.readonly"],
    )
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def safe_extract(tar: tarfile.TarFile, output_dir: Path) -> None:
    output_root = output_dir.resolve()
    for member in tar.getmembers():
        target = (output_dir / member.name).resolve()
        if output_root != target and output_root not in target.parents:
            raise RuntimeError(f"Unsafe tar member path: {member.name}")
    tar.extractall(output_dir)


def main() -> None:
    args = parse_args()
    if not args.file_id:
        raise RuntimeError("GOOGLE_DRIVE_MODEL_ASSET_BUNDLE_ID is required.")

    service = build_drive_service()
    request = service.files().get_media(fileId=args.file_id, supportsAllDrives=True)
    buffer = io.BytesIO()

    from googleapiclient.http import MediaIoBaseDownload

    downloader = MediaIoBaseDownload(buffer, request, chunksize=32 * 1024 * 1024)
    done = False
    while not done:
        status, done = downloader.next_chunk()
        if status:
            print(f"Downloaded {int(status.progress() * 100)}%")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    buffer.seek(0)
    with tarfile.open(fileobj=buffer, mode="r:gz") as tar:
        safe_extract(tar, args.output_dir)

    expected = [
        args.output_dir / "models/kitten-tts-nano-0.8/kitten_tts_nano_v0_8.onnx",
        args.output_dir / "models/kitten-tts-nano-0.8-int8/kitten_tts_nano_v0_8.onnx",
        args.output_dir / "models/kitten-tts-micro-0.8/kitten_tts_micro_v0_8.onnx",
        args.output_dir / "models/kitten-tts-mini-0.8/kitten_tts_mini_v0_8.onnx",
    ]
    missing = [str(path) for path in expected if not path.is_file()]
    if missing:
        raise RuntimeError(f"Model bundle is missing expected files: {missing}")

    print(f"Extracted model assets to {args.output_dir}")


if __name__ == "__main__":
    main()
