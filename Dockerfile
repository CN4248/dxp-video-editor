# syntax=docker/dockerfile:1
# CineCut · 视频剪辑工坊
# 目标平台：绿联 DXP4800 Plus（x86_64）UGOS Pro / Docker 24+
#
# 缓存分层（重要）：
#   1. runtime 阶段只装 ffmpeg/字体（最慢，尽量命中缓存）
#   2. app 阶段先 COPY 代码 + 自检，再写版本号 ENV/LABEL
# 这样改代码或改版本号时都不会重装 ffmpeg；正常重建通常只需几秒。
ARG BASE_IMAGE=python:3.12-alpine3.21

FROM ${BASE_IMAGE} AS runtime
ARG APK_MIRROR=

# 可选：国内网络构建时把 Alpine 源替换为镜像站。
# 这一层只依赖 APK_MIRROR；不要在这里放版本号/业务 ENV，否则每次发版都会重装依赖。
RUN if [ -n "$APK_MIRROR" ]; then \
        sed -i "s|dl-cdn.alpinelinux.org|${APK_MIRROR}|g" /etc/apk/repositories; \
    fi \
    && REPO="https://${APK_MIRROR:-dl-cdn.alpinelinux.org}/alpine/v3.21/community" \
    && apk add --no-cache --repository "$REPO" \
        ffmpeg \
        font-wqy-zenhei \
        font-dejavu \
        tzdata \
        ca-certificates


FROM runtime AS app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    INPUT_ROOT=/input \
    OUTPUT_ROOT=/output \
    DATA_DIR=/data \
    PORT=3873

WORKDIR /app
# 先 COPY app：只改 VERSION 时，代码层仍可命中缓存。
COPY app /app/app
COPY VERSION /app/VERSION

RUN mkdir -p /input /output /data \
    && python3 -m app.server --check

# 版本号放在 COPY 之后：只改版本时不会让代码层失效。
ARG APP_VERSION=1.3.2
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="CineCut" \
      org.opencontainers.image.description="CineCut 视频剪辑工坊" \
      org.opencontainers.image.version="${APP_VERSION}"

EXPOSE 3873
VOLUME ["/input", "/output", "/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3873/healthz', timeout=3)"

CMD ["python3", "-m", "app.server"]
