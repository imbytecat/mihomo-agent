// A listener-only fixture: no proxy traffic, routes or firewall changes.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

func main() {
	version := flag.Bool("v", false, "")
	validate := flag.Bool("t", false, "")
	_ = flag.String("d", "", "")
	config := flag.String("f", "", "")
	flag.Parse()
	if *version {
		fmt.Println("Mihomo Meta v0.0.0-fixture linux amd64 with Go")
		return
	}
	data, err := os.ReadFile(*config)
	if err != nil || !strings.Contains(string(data), "proxies:") {
		os.Exit(1)
	}
	if *validate {
		return
	}
	if strings.Contains(string(data), "fixture-exit: true") {
		os.Exit(1)
	}
	for _, port := range []string{"7894", "1053"} {
		tcp, err := net.Listen("tcp4", "127.0.0.1:"+port)
		if err != nil {
			panic(err)
		}
		defer tcp.Close()
		udp, err := net.ListenPacket("udp4", "127.0.0.1:"+port)
		if err != nil {
			panic(err)
		}
		defer udp.Close()
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	<-ctx.Done()
}
