package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadTailKeepsCompleteLinesWithinLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	for _, tc := range []struct{ input, want string }{
		{"", ""}, {"short", "short"}, {"12345678", "12345678"},
		{"discard\n12345678", "12345678"}, {"discard\nend\n", "end\n"},
		{"123456789", ""}, {"discard\nlast", "last"},
	} {
		if err := os.WriteFile(path, []byte(tc.input), 0600); err != nil {
			t.Fatal(err)
		}
		data, err := ReadTail(path, 8)
		if err != nil || string(data) != tc.want {
			t.Errorf("ReadTail(%q) = %q, %v; want %q", tc.input, data, err, tc.want)
		}
	}
}
