.PHONY: build check ui test-ui release

build:
	go build -o .build/mihomo-agent ./cmd/mihomo-agent

check:
	go test -race ./...
	go vet ./...
	cd ui && bun install --frozen-lockfile
	cd ui && bun run check
	cd ui && bun run build
	cd ui && bun test
	shellcheck -x -s sh ui/src/transport/ufi-bootstrap.sh internal/platform/network_ufi.sh

ui:
	cd ui && bun run build

test-ui:
	cd ui && bun run test:ui

release:
	go run ./tools/release -version "$(VERSION)"
