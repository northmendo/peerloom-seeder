# Build the PeerLoom Seeder package for StartOS 0.4: `make` (run it twice
# after changing the manifest; the SDK reads its file list before building).
# Needs the 0.4 CLI as `start-cli` on PATH (`make` puts start-cli-1.1.0 there
# through bin/) and a signing workspace in ../.startos (gitignored).
# See README.md.
ARCHES := x86
$(shell mkdir -p bin && ln -sf "$$(command -v start-cli-1.1.0)" bin/start-cli)
export PATH := $(CURDIR)/bin:$(PATH)
include node_modules/@start9labs/start-sdk/s9pk.mk
