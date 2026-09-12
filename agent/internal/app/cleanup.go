package app

import (
	"os"
	"sort"
)

// Called with the control lock: no other worker can own these staging files.
func (a *Agent) pruneTaskFiles() {
	entries, _ := os.ReadDir(a.path("tasks"))
	for _, entry := range entries {
		if entry.IsDir() && validID(entry.Name()) {
			_ = os.RemoveAll(a.taskPath(entry.Name(), "work"))
			_ = os.Remove(a.taskPath(entry.Name(), "request.bin"))
		}
	}
	// Keep task state records for replay protection. Keep current + two prior configs.
	active, err := a.activeGeneration()
	if err != nil || regularFile(a.runtime("pending.json")) {
		return
	}
	entries, _ = os.ReadDir(a.runtime("configurations"))
	type generation struct {
		id       string
		modified int64
	}
	var old []generation
	for _, entry := range entries {
		if entry.IsDir() && validID(entry.Name()) && entry.Name() != active {
			if info, err := entry.Info(); err == nil {
				old = append(old, generation{entry.Name(), info.ModTime().UnixNano()})
			}
		}
	}
	sort.Slice(old, func(i, j int) bool { return old[i].modified > old[j].modified })
	for i := 2; i < len(old); i++ {
		_ = os.RemoveAll(a.runtime("configurations", old[i].id))
	}
}
