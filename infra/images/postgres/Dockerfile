# syntax=docker/dockerfile:1

ARG BASE_IMAGE=ghcr.io/cloudnative-pg/postgis:18.4-3.6.4-202607131106-system-trixie@sha256:6153a4d0bc929db01a156e50558a253111d7aeffa44b8c1a57c7e7ea88e81ebc

FROM ${BASE_IMAGE} AS extensions

USER root

ARG PG_MAJOR=18
ARG PG_TEXTSEARCH_VERSION=1.3.1
ARG PG_TEXTSEARCH_SHA256=9f256dc7f082235d8fead7df361427e0a0344a9ee64662f3b50449eeb90bbc7c
ARG PGVECTOR_VERSION=0.8.5
ARG PGVECTOR_SHA256=6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    postgresql-server-dev-${PG_MAJOR} \
    unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN curl -fsSLo pg_textsearch.zip \
    "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/pg-textsearch-v${PG_TEXTSEARCH_VERSION}-pg${PG_MAJOR}-amd64.zip" \
  && echo "${PG_TEXTSEARCH_SHA256}  pg_textsearch.zip" | sha256sum --check --strict \
  && unzip -q pg_textsearch.zip \
  && dpkg-deb --extract "pg-textsearch-postgresql-${PG_MAJOR}_${PG_TEXTSEARCH_VERSION}-1_amd64.deb" /stage

RUN curl -fsSLo pgvector.tar.gz \
    "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
  && echo "${PGVECTOR_SHA256}  pgvector.tar.gz" | sha256sum --check --strict \
  && tar -xzf pgvector.tar.gz \
  && make -C "pgvector-${PGVECTOR_VERSION}" OPTFLAGS="" \
  && make -C "pgvector-${PGVECTOR_VERSION}" install DESTDIR=/stage

FROM ${BASE_IMAGE}

USER root
COPY --from=extensions /stage/ /

RUN test -f /usr/lib/postgresql/18/lib/pg_textsearch.so \
  && test -f /usr/share/postgresql/18/extension/pg_textsearch--1.3.1.sql \
  && test -f /usr/lib/postgresql/18/lib/vector.so \
  && test -f /usr/share/postgresql/18/extension/vector.control

LABEL ca.renoconcierge.postgresql.major="18" \
  ca.renoconcierge.postgis.version="3.6.4" \
  ca.renoconcierge.pg_textsearch.version="1.3.1" \
  ca.renoconcierge.pgvector.version="0.8.5"

USER 26
