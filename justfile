set positional-arguments
set shell := ["bash", "-euo", "pipefail", "-c"]

# List development commands.
default:
    @just --list

# Build the native CLI without frontend dependencies.
build:
    CGO_ENABLED=0 go build -o .build/mihomo-agent ./cmd/mihomo-agent

# Install frontend and browser-test dependencies from the lockfile.
deps:
    bun install --cwd ui --frozen-lockfile

# Run Go, frontend, shell and workflow checks.
check: lint test-go check-ui

# Check Go formatting, static analysis, shell scripts and CI syntax.
lint:
    just --fmt --check
    @files="$(gofmt -l cmd internal)"; if [[ -n "$files" ]]; then printf '%s\n' "$files"; exit 1; fi
    go vet ./...
    sqlc diff
    goreleaser check
    shellcheck -x -s sh ui/src/transport/ufi-bootstrap.sh internal/platform/network_ufi.sh
    actionlint

# Format Go source.
fmt:
    just --fmt
    gofmt -w cmd internal

# Run Go tests with the race detector.
test-go:
    go test -race ./...

# Type-check, build and test the frontend and native bridge.
check-ui: deps
    bun run --cwd ui check
    bun run --cwd ui build
    bun run --cwd ui test

# Build the single-file UFI plugin.
ui: deps
    bun run --cwd ui build

# Install the browser used by UI tests.
browser-install: deps
    bun run --cwd ui browser:install

# Test the production plugin in Vitest Browser Mode.
test-ui: deps
    bun run --cwd ui test:ui

# Run only in isolated Linux CI with MIHOMO_SYSTEMD_TEST=1.
test-systemd:
    test "${MIHOMO_SYSTEMD_TEST:-}" = 1 && test "$(uname -s)" = Linux
    go build -o .build/mihomo-agent-ci ./cmd/mihomo-agent
    go build -o .build/mihomo-core-fixture ./internal/integration/testdata/core
    go test -c -o .build/systemd-integration ./internal/integration
    sudo env MIHOMO_SYSTEMD_TEST=1 MIHOMO_TEST_AGENT="$PWD/.build/mihomo-agent-ci" MIHOMO_TEST_CORE="$PWD/.build/mihomo-core-fixture" .build/systemd-integration -test.v -test.timeout=4m

# Generate typed SQLite queries after editing schema.sql or queries.sql.
generate:
    sqlc generate

# Build assets from the current Git tag without publishing.
release:
    goreleaser release --clean --skip=publish

# Preview all release assets without creating a tag or publishing.
snapshot:
    goreleaser release --snapshot --clean --skip=publish
