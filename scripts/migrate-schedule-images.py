#!/usr/bin/env python3
"""Move embedded X schedule images out of the JSON queue into durable files."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
from datetime import datetime, timezone


DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)
EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir", type=Path)
    args = parser.parse_args()

    data_dir = args.data_dir.resolve()
    queue_path = data_dir / "x-scheduled-posts.json"
    image_dir = data_dir / "x-schedule-images"
    if not queue_path.is_file():
        raise SystemExit(f"schedule queue not found: {queue_path}")

    with queue_path.open("r", encoding="utf-8-sig") as handle:
        queue = json.load(handle)
    if not isinstance(queue, list):
        raise SystemExit("schedule queue must be a JSON array")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = queue_path.with_name(f"x-scheduled-posts.pre-image-migration-{stamp}.json")
    shutil.copy2(queue_path, backup_path)
    image_dir.mkdir(parents=True, exist_ok=True)

    migrated = 0
    migrated_bytes = 0
    for job in queue:
        if not isinstance(job, dict):
            continue
        data_url = str(job.get("imageDataUrl") or "")
        if not data_url:
            continue
        match = DATA_URL_RE.match(data_url)
        if not match:
            raise SystemExit(f"invalid image data URL for schedule job: {job.get('id', '')}")
        job_id = str(job.get("id") or "").strip()
        if not job_id or not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
            raise SystemExit(f"invalid schedule job id: {job_id}")
        mime_type = match.group(1).lower()
        extension = EXTENSIONS.get(mime_type, ".png")
        image_bytes = base64.b64decode(match.group(2), validate=True)
        image_path = image_dir / f"{job_id}{extension}"
        image_tmp_path = image_path.with_suffix(f"{image_path.suffix}.tmp")
        image_tmp_path.write_bytes(image_bytes)
        os.replace(image_tmp_path, image_path)
        job["imageFile"] = image_path.relative_to(data_dir).as_posix()
        job["imageMimeType"] = mime_type
        job["imageDataUrl"] = ""
        migrated += 1
        migrated_bytes += len(image_bytes)

    queue_tmp_path = queue_path.with_suffix(".json.tmp")
    with queue_tmp_path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(queue, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    with queue_tmp_path.open("r", encoding="utf-8") as handle:
        verified = json.load(handle)
    if not isinstance(verified, list) or len(verified) != len(queue):
        raise SystemExit("migrated queue verification failed")
    os.replace(queue_tmp_path, queue_path)

    print(json.dumps({
        "ok": True,
        "jobs": len(queue),
        "migratedImages": migrated,
        "migratedBytes": migrated_bytes,
        "queuePath": str(queue_path),
        "backupPath": str(backup_path),
        "imageDir": str(image_dir),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
