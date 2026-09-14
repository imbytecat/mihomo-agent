package manager

import (
	"context"
	"sync"
	"time"

	"github.com/imbytecat/mihomoctl/internal/redact"
	"github.com/imbytecat/mihomoctl/internal/storage"
)

type ComponentUpdate = storage.ComponentUpdate
type Updates = storage.Updates

// CheckUpdates queries metadata only; each component can fail independently.
func (a *Manager) CheckUpdates(ctx context.Context) (Updates, error) {
	var result Updates
	if err := a.requireIdentity(); err != nil {
		return result, err
	}
	result.Self = ComponentUpdate{Current: a.Version, State: "unknown"}
	result.Core.State = "not-installed"
	if a.coreInstalled() {
		result.Core = ComponentUpdate{Current: a.coreVersion(), State: "unknown"}
	}
	result.Dashboard.State = "not-installed"
	if dashboard := a.dashboard(); dashboard.Installed {
		result.Dashboard = ComponentUpdate{Current: dashboard.Version, State: "unknown"}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var group sync.WaitGroup
	for _, target := range []struct {
		owner, repo string
		update      *ComponentUpdate
	}{
		{"imbytecat", "mihomoctl", &result.Self},
		{"MetaCubeX", "mihomo", &result.Core},
		{"Zephyruso", "zashboard", &result.Dashboard},
	} {
		group.Go(func() {
			r, err := a.latestRelease(ctx, target.owner, target.repo)
			if err != nil {
				target.update.State = "error"
				target.update.Error = redact.String(err.Error())
				return
			}
			target.update.Latest = r.GetTagName()
			if target.update.State == "not-installed" {
				return
			}
			current, err := releaseVersion(target.update.Current)
			if err != nil {
				return
			}
			latest, _ := releaseVersion(r.GetTagName())
			target.update.State = "up-to-date"
			if latest.GreaterThan(current) {
				target.update.State = "available"
			}
		})
	}
	group.Wait()
	result.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	return result, a.store.SaveUpdates(result)
}
