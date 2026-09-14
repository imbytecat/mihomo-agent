package download

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
)

func VerifySHA256(reader io.Reader, digest string) error {
	hash := sha256.New()
	if _, err := io.Copy(hash, reader); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("下载文件 SHA-256 不匹配，拒绝安装")
	}
	return nil
}
