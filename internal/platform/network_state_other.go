//go:build !linux

package platform

import "errors"

func NetworkState(_ string, _, _ int, _ uint32) (bool, error) {
	return false, errors.New("路由 netlink 检查仅支持 Linux / Android")
}
