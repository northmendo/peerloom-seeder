# PeerLoom Seeder for Umbrel and other Docker hosts. The build context is
# dist/umbrel (scripts/build-umbrel-image.sh stages it per arch with
# scripts/stage.js), so nothing is compiled or installed under emulation:
# the Bare runtime, the seeder bundle with that arch's addons (and its own
# libatomic) and the host, which runs on the image's Node.
FROM node:22-bookworm-slim
ARG TARGETARCH
WORKDIR /app
COPY ${TARGETARCH}/ /app/
# Runs with host networking (devices dial in to pair; Docker's bridge NAT
# stops that), so it listens on every interface and the dashboard asks for
# SEEDER_PASSWORD (Umbrel passes its app password; otherwise one is made and
# saved in /data).
ENV SEEDER_HOST=0.0.0.0 \
    SEEDER_PORT=8761 \
    SEEDER_DATA=/data \
    SEEDER_NO_UPDATE_CHECK=1
VOLUME /data
EXPOSE 8761
# Root, as Umbrel mounts ${APP_DATA_DIR} root-owned; compose sets
# no-new-privileges. The seeder stores only encrypted blocks.
CMD ["node", "/app/host/server.js"]
