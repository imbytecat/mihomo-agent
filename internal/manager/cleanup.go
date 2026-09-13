package manager

import "os"

func (a *Manager) pruneTaskFiles() {
	_ = a.store.PruneRequests()
	entries, _ := os.ReadDir(a.path("tasks"))
	for _, entry := range entries {
		if entry.IsDir() && validID(entry.Name()) {
			_ = os.RemoveAll(a.taskPath(entry.Name(), "work"))
		}
	}
	active, err := a.activeGeneration()
	if err != nil {
		return
	}
	pending, err := a.store.Pending()
	if err != nil || pending != nil {
		return
	}
	old, err := a.store.OldConfigurations(active)
	if err != nil {
		return
	}
	for _, id := range old {
		if validID(id) {
			if err := os.RemoveAll(a.runtime("configurations", id)); err == nil {
				_ = a.store.DeleteConfiguration(id)
			}
		}
	}
}
