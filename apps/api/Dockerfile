# syntax=docker/dockerfile:1

# 默认走 DaoCloud 代理，避免直连 Docker Hub 过慢；海外可 build-arg 改回 docker.io/library
ARG BASE_REGISTRY=docker.m.daocloud.io/library
FROM ${BASE_REGISTRY}/python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=60

# 国内 pip 源，加速依赖安装
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
