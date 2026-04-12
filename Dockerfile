# Workbench: a single dev/run container with every toolchain the demo
# needs. Users bind-mount the repo and edit on the host; the container
# builds and serves. No production slimming — this image exists to make
# "clone and run" painless without installing Rust + Python + Java on
# the host.

FROM rustlang/rust:nightly-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    RUST_BACKTRACE=1

# Base system deps + Adoptium repo for Java 21 (Planetiler requires 21+,
# which isn't in Debian bookworm main).
RUN apt-get update && apt-get install -y --no-install-recommends \
        gnupg curl wget ca-certificates \
    && curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
        | gpg --dearmor > /usr/share/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" \
        > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        # Planetiler (dataset builder)
        temurin-21-jre \
        # prepare_tiles.py + flask proxy + extract scripts
        python3 python3-pip \
        # tile-mbtiles inspection, network tooling, build deps
        sqlite3 iproute2 procps \
        pkg-config libssl-dev \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

# Python runtime deps for the Flask proxy + scripts
RUN pip install --no-cache-dir \
        flask requests psutil

# Rust tooling. cargo-watch gives the live-reload dev loop;
# wasm-pack builds the browser client.
RUN cargo install --locked wasm-pack cargo-watch

# Pre-install the pinned nightly so the first `cargo` call inside the
# bind-mounted workspace doesn't spend a minute downloading. The actual
# pin lives in server/rust-toolchain.toml; rustup picks it up on demand.
# This warm-up is opportunistic — if the pin moves we just pay the
# download cost once per image build.
RUN rustup install nightly-2024-02-07 \
 && rustup target add wasm32-unknown-unknown --toolchain nightly-2024-02-07

WORKDIR /workspace
EXPOSE 8009 8084

ENTRYPOINT ["./scripts/dev-up.sh"]
