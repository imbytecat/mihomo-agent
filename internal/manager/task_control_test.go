package manager

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDownloadProgressAndCancellationInDetachedWorker(t *testing.T) {
	a := testAgent(t)
	old := []byte("previous core remains installed")
	if err := os.WriteFile(a.corePath(), old, 0700); err != nil {
		t.Fatal(err)
	}
	disconnected := make(chan struct{})
	shutdown := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1048576")
		_, _ = w.Write(make([]byte, 4096))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-shutdown:
		}
		close(disconnected)
	}))
	defer server.Close()
	defer close(shutdown)
	t.Setenv("UFI_TEST_HTTP", server.URL)
	job, err := a.Submit(Request{Action: "update", Params: Params{URL: "https://example.invalid/subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		job, err = a.Job(job.ID)
		if err != nil {
			t.Fatal(err)
		}
		if job.Downloaded > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no persisted progress: %+v", job)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if job.Total != 1048576 || job.Speed <= 0 || !job.Cancellable {
		t.Fatalf("incomplete progress: %+v", job)
	}
	if _, err := a.Cancel(job.ID); err != nil {
		t.Fatal(err)
	}
	finished := waitJob(t, a, job.ID)
	if finished.State != "cancelled" || finished.Cancellable || !finished.CancelRequested {
		t.Fatalf("wrong cancellation: %+v", finished)
	}
	select {
	case <-disconnected:
	case <-time.After(2 * time.Second):
		t.Fatal("download connection remained open")
	}
	if data, _ := os.ReadFile(a.corePath()); string(data) != string(old) {
		t.Fatal("cancel changed the installed core")
	}
	if _, err := os.Stat(a.taskPath(job.ID, "work")); !os.IsNotExist(err) {
		t.Fatal("cancel retained partial download")
	}
	if data, err := a.store.Request(job.ID); err != nil || len(data) != 0 {
		t.Fatal("cancel retained encrypted request", err)
	}
	log, err := a.JobLog(job.ID)
	if err != nil || !strings.Contains(log, "time=") || !strings.Contains(log, "duration=") || !strings.Contains(log, "任务已取消") {
		t.Fatal("missing timed terminal log", log, err)
	}
}

func TestCancellationAndCommitAreMutuallyExclusive(t *testing.T) {
	for _, cancelFirst := range []bool{true, false} {
		a := testAgent(t)
		job := Job{ID: randomID(), State: "running", Cancellable: true}
		if err := a.store.CreateTask(job, "fingerprint", []byte("ciphertext")); err != nil {
			t.Fatal(err)
		}
		if cancelFirst {
			if ok, err := a.store.CancelTask(job.ID); err != nil || !ok {
				t.Fatal(ok, err)
			}
			job.Downloaded = 42
			if err := a.writeJob(&job); err != nil {
				t.Fatal(err)
			}
			if err := a.store.CommitTask(job.ID); err != context.Canceled {
				t.Fatal("commit overwrote cancellation", err)
			}
		} else {
			if err := a.store.CommitTask(job.ID); err != nil {
				t.Fatal(err)
			}
			if err := a.writeJob(&job); err != nil {
				t.Fatal(err)
			}
			if ok, err := a.store.CancelTask(job.ID); err != nil || ok {
				t.Fatal("progress reopened cancellation", ok, err)
			}
		}
	}
}
