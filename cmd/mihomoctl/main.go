package main

import (
	"encoding/json"
	"os"

	"github.com/imbytecat/mihomoctl/internal/cli"
	"github.com/imbytecat/mihomoctl/internal/redact"
)

var version = "dev"

func main() {
	if err := cli.New(version).Execute(); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": redact.String(err.Error())})
		os.Exit(1)
	}
}
