# MinIO server and mc, built from source at the pinned release tags (#240).
#
# Docker Hub and then quay.io stopped serving these tags (`unauthorized`):
# MinIO no longer publishes free community images. Building the same tags keeps
# the server version unchanged for dev, prod and CI (.github/workflows/ci.yml
# builds the server the same way). Bump all three together.
#
# One image carries both binaries: the server's healthcheck runs `mc ready
# local`, as it did in the official image, and the createbucket one-shot runs
# `mc` from the same image.
ARG MINIO_TAG=RELEASE.2025-04-22T22-12-26Z
ARG MC_TAG=RELEASE.2025-04-16T18-13-26Z

FROM golang:1.24 AS build
ARG MINIO_TAG
ARG MC_TAG
ENV CGO_ENABLED=0
# gen-ldflags.go is each project's own release stamp: without it both binaries
# report DEVELOPMENT.GOGET instead of the release they are.
RUN git clone --quiet --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git /src/minio \
 && cd /src/minio && go build -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio .
RUN git clone --quiet --depth 1 --branch "$MC_TAG" https://github.com/minio/mc.git /src/mc \
 && cd /src/mc && go build -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/mc .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /out/mc /usr/bin/
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
