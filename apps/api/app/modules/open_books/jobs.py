"""公版书下载任务进度（进程内，个人版够用）。"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

JobStatus = Literal["pending", "running", "done", "failed"]


@dataclass
class ImportJob:
    id: str
    status: JobStatus = "pending"
    progress: int = 0
    message: str = "排队中…"
    source_id: int | None = None
    title: str = ""
    filename: str = ""
    direct_ingest: bool = False
    error: str = ""
    created_at: float = field(default_factory=time.time)


_JOBS: dict[str, ImportJob] = {}


def create_job(*, direct_ingest: bool = False) -> ImportJob:
    job = ImportJob(id=uuid.uuid4().hex[:16], direct_ingest=direct_ingest)
    _JOBS[job.id] = job
    # 简单清理：超过 200 个任务时丢掉最旧的已结束任务
    if len(_JOBS) > 200:
        finished = sorted(
            (j for j in _JOBS.values() if j.status in {"done", "failed"}),
            key=lambda j: j.created_at,
        )
        for j in finished[:50]:
            _JOBS.pop(j.id, None)
    return job


def get_job(job_id: str) -> ImportJob | None:
    return _JOBS.get(job_id)


def update_job(job_id: str, **kwargs: Any) -> None:
    job = _JOBS.get(job_id)
    if not job:
        return
    for k, v in kwargs.items():
        if hasattr(job, k):
            setattr(job, k, v)


def job_to_dict(job: ImportJob) -> dict[str, Any]:
    return {
        "job_id": job.id,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "source_id": job.source_id,
        "title": job.title,
        "filename": job.filename,
        "direct_ingest": job.direct_ingest,
        "error": job.error,
    }
