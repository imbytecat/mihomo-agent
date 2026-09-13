package main

import "testing"

func TestReleaseVersion(t *testing.T) {
	for _, version := range []string{"v0.5.0", "v1.20.300"} {
		if !validVersion(version) {
			t.Fatalf("rejected stable version %q", version)
		}
	}
	for _, version := range []string{"", "v01.2.3", "v1.2.3-beta.1", "v1.2.3+build", "1.2.3", "v1.2", "agent-v1.2.3", "v1.2.3/../x"} {
		if validVersion(version) {
			t.Fatalf("accepted invalid release version %q", version)
		}
	}
}
