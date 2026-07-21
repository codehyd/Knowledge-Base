# syntax=docker/dockerfile:1

ARG BASE_REGISTRY=docker.m.daocloud.io/library

FROM ${BASE_REGISTRY}/node:22-alpine AS build
WORKDIR /app

ENV npm_config_registry=https://registry.npmmirror.com

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install

COPY . .
RUN npm run build

FROM ${BASE_REGISTRY}/nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
