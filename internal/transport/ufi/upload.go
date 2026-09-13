// Package ufi adapts UFI's public upload area to a private manager request.
package ufi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

type Upload struct {
	Bytes    []byte
	path     string
	identity os.FileInfo
}

func ReadUpload(directory, name, digest string) (*Upload, error) {
	if len(name) != 40 || !strings.HasSuffix(name, ".bin") || uuid.Validate(strings.TrimSuffix(name, ".bin")) != nil || len(digest) != 64 {
		return nil, errors.New("无效上传引用")
	}
	path := filepath.Join(directory, name)
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
		return nil, errors.New("上传请求不是普通文件")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	identity, err := file.Stat()
	if err != nil || !os.SameFile(before, identity) {
		return nil, errors.New("上传文件已改变")
	}
	data, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return nil, errors.New("上传请求过大或不可读")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != digest {
		return nil, errors.New("上传请求校验失败")
	}
	return &Upload{Bytes: data, path: path, identity: identity}, nil
}
func (u *Upload) Consume() error {
	current, err := os.Lstat(u.path)
	if err != nil || !os.SameFile(u.identity, current) {
		return errors.New("上传文件已被替换")
	}
	return os.Remove(u.path)
}
