# Device agent

Native Go CLI for F50. No HTTP server and no Node/Bun/yq runtime on the device.

```sh
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o ufi-agent .
```

The browser talks only to UFI. It reads the public key from `inspect`, seals a request with libsodium-compatible anonymous boxes, uploads ciphertext, and calls `submit`. Request integrity is checked before decryption. Secrets never enter shell arguments or public upload files as plaintext.

`submit` acquires the OS file lock, writes a durable task record, then transfers the locked file descriptor to a detached worker. The browser may close after acceptance. `job` and `inspect` expose state after reconnecting; abandoned tasks become interrupted rather than remaining busy forever. The browser does not orchestrate task steps.

The worker handles official release lookup, native HTTP/TLS, compressed download verification, YAML parsing, configuration validation and activation. Configuration generations include the original subscription, runtime YAML, private source URL and protected listener ports. Switching the active symlink is atomic; an unfinished activation journal restores the previous generation.

`supervise` manages the core and invokes the embedded network bridge for Android `ip`/`iptables` operations. Core traffic stays in mihomo. Network operations use their own inherited OS lock, and process records include birth time to reject recycled PIDs.

Layout:

```text
/data/ufi-mihomo/
  agent, identity.json, control.lock
  tasks/<id>/{request.bin,state.json,log.txt}
  runtime/{mihomo,settings.json,network.sh,current,configurations/...}
  backups/runtime-<timestamp>-<id>/
```

Uninstall removes the proxy runtime by moving it to a backup. The management agent, key and task records remain so completion can still be queried. Initialization refuses nonempty unmanaged directories; this is not a migration layer for older plugins.

Host tests cover sealed requests, OS-lock handoff, detached workers, interrupted tasks, URL validation, configuration preservation and rollback. ARM builds and F50 networking require separate integration checks.
