package storage

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOldSchemaIsRejectedWithoutMigration(t *testing.T) {
	root := t.TempDir()
	if err := Initialize(root, Identity{}, Deployment{Kind: "ufi"}, Controller{}); err != nil {
		t.Fatal(err)
	}
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	old := schemaVersion - 1
	if _, err := s.db.Exec(fmt.Sprintf("PRAGMA user_version=%d", old)); err != nil {
		t.Fatal(err)
	}
	if current, err := Open(root); err == nil {
		current.Close()
		t.Fatal("accepted old schema")
	}
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != old {
		t.Fatal("opening old state migrated it", version, err)
	}
}

func TestStoreTransactionsAndPrivateState(t *testing.T) {
	root := t.TempDir()
	if _, err := Open(root); !os.IsNotExist(err) {
		t.Fatal("opening status created state", err)
	}
	identity := Identity{Protocol: 2}
	identity.Public[0] = 1
	identity.Private[0] = 2
	deployment := Deployment{Kind: "ufi"}
	if err := Initialize(root, identity, deployment, Controller{Enabled: true, Port: 9090, Secret: "fixture-secret"}); err != nil {
		t.Fatal(err)
	}
	db, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if info, _ := os.Stat(filepath.Join(root, Filename)); info.Mode().Perm() != 0600 {
		t.Fatal("database is not private")
	}
	if actual, err := db.Identity(); err != nil || actual != identity {
		t.Fatal("identity changed", err)
	}
	if actual, err := db.Deployment(); err != nil || actual != deployment {
		t.Fatal("deployment changed", err)
	}
	first := Task{ID: "first", Action: "update", State: "running", Phase: "subscription", Updated: "now", Hash: "cipher-hash"}
	if err := db.CreateTask(first, "private-hmac", []byte("ciphertext")); err != nil {
		t.Fatal(err)
	}
	duplicate := first
	duplicate.State = "queued"
	if err := db.CreateTask(duplicate, "different", nil); err == nil {
		t.Fatal("duplicate task accepted")
	}
	if task, err := db.Task(first.ID); err != nil || task.State != "running" {
		t.Fatal("failed insert partially changed existing state", err)
	}
	if data, err := db.Request(first.ID); err != nil || !bytes.Equal(data, []byte("ciphertext")) {
		t.Fatal("request not atomic", err)
	}
	if latest, err := db.LatestTask(); err != nil || latest != first.ID {
		t.Fatal("latest pointer not committed", err)
	}
	if err := db.SavePending(Pending{Next: "missing"}); err == nil {
		t.Fatal("accepted dangling config journal")
	}
	if pending, err := db.Pending(); err != nil || pending != nil {
		t.Fatal("failed journal write changed state", err)
	}
	first.State = "succeeded"
	if err := db.UpdateTask(first); err != nil {
		t.Fatal(err)
	}
	if data, _ := db.Request(first.ID); len(data) != 0 {
		t.Fatal("retained completed request")
	}
	if fingerprint, _ := db.Fingerprint(first.ID); fingerprint != "private-hmac" {
		t.Fatal("removed replay protection")
	}
	if err := db.ClearLatest(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.LatestTask(); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("latest pointer was not cleared")
	}
}

func TestTerminalTasksClearRequestsAtomically(t *testing.T) {
	root := t.TempDir()
	if err := Initialize(root, Identity{}, Deployment{Kind: "ufi"}, Controller{}); err != nil {
		t.Fatal(err)
	}
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, state := range []string{"succeeded", "failed", "interrupted", "cancelled", "superseded"} {
		t.Run(state, func(t *testing.T) {
			task := Task{ID: state, Action: "update", State: "queued"}
			if err := s.CreateTask(task, "keep-hmac", []byte("ciphertext")); err != nil {
				t.Fatal(err)
			}
			task.State = "running"
			if err := s.UpdateTask(task); err != nil {
				t.Fatal(err)
			}
			if data, err := s.Request(task.ID); err != nil || string(data) != "ciphertext" {
				t.Fatal("lost active request", err)
			}
			if state == "superseded" {
				err = s.CreateTask(Task{ID: "next", State: "queued"}, "next-hmac", []byte("next request"))
			} else {
				task.State = state
				err = s.UpdateTask(task)
			}
			if err != nil {
				t.Fatal(err)
			}
			if data, err := s.Request(task.ID); err != nil || len(data) != 0 {
				t.Fatal("terminal transition retained ciphertext", err)
			}
			if fingerprint, err := s.Fingerprint(task.ID); err != nil || fingerprint != "keep-hmac" {
				t.Fatal("lost replay protection", err)
			}
		})
	}
}

func TestRemovalExcludesExistingAndNewReaders(t *testing.T) {
	root := t.TempDir()
	if err := Initialize(root, Identity{Protocol: 2}, Deployment{Kind: "ufi"}, Controller{Enabled: true, Port: 9090, Secret: "fixture"}); err != nil {
		t.Fatal(err)
	}
	reader, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	if pin, err := Exclusive(ctx, root); err == nil {
		pin.Close()
		t.Fatal("removal overlapped a live reader")
	}
	cancel()
	reader.Close()
	pin, err := Exclusive(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer pin.Close()
	for range 20 {
		if next, err := Open(root); err == nil {
			next.Close()
			t.Fatal("new reader entered during removal")
		}
	}
	for _, file := range []string{Filename + "-wal", Filename + "-shm", Filename, Lockfile} {
		if err := os.Remove(filepath.Join(root, file)); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root); !os.IsNotExist(err) {
		t.Fatal("opening removed state recreated files")
	}
}
