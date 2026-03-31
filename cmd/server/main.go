package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/ryotarai/claude-code-wrapper-ui/internal/ws"
)

func main() {
	port := flag.Int("port", 8080, "HTTP port")
	command := flag.String("command", "claude", "Command to run in pty")
	staticDir := flag.String("static", "frontend/dist", "Static files directory")
	flag.Parse()

	handler := ws.NewHandler(*command)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.ServeHTTP)
	mux.Handle("/", http.FileServer(http.Dir(*staticDir)))

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Listening on %s", addr)

	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down")
}
