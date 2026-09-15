package manager

import (
	"io"
	"time"
)

// Progress belongs to the current transfer, not to the lifecycle of its caller.
type transferReader struct {
	io.Reader
	idle              *time.Timer
	limit             time.Duration
	report            func(int64, int64, float64) error
	downloaded, total int64
	started, reported time.Time
}

func (r *transferReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n > 0 {
		r.idle.Reset(r.limit)
		r.downloaded += int64(n)
		if r.report != nil && (time.Since(r.reported) >= time.Second || err == io.EOF) {
			err = r.flush(err)
		}
	}
	return n, err
}

func (r *transferReader) flush(err error) error {
	if r.report != nil {
		now := time.Now()
		if reportErr := r.report(r.downloaded, r.total, float64(r.downloaded)/max(now.Sub(r.started).Seconds(), 0.001)); reportErr != nil {
			return reportErr
		}
		r.reported = now
	}
	return err
}
