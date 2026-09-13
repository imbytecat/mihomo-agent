package redact

import (
	"regexp"
	"strings"
)

var secretLine = regexp.MustCompile(`(?i)(password|secret|token|authorization|uuid|private.key)[\s"=:]`)
var addressPattern = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"<>]+`)

func String(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		line = addressPattern.ReplaceAllString(line, "[URL hidden]")
		if secretLine.MatchString(line) {
			line = "[sensitive log line hidden]"
		}
		lines[i] = line
	}
	return strings.Join(lines, "\n")
}
