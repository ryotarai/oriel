package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/ryotarai/claude-code-wrapper-ui/internal/ws"
)

func main() {
	listenAddr := flag.String("listen-addr", ":8080", "Listen address (e.g. :8080, 127.0.0.1:3000)")
	command := flag.String("command", "claude", "Command to run in pty")
	staticDir := flag.String("static", "frontend/dist", "Static files directory")
	flag.Parse()

	handler := ws.NewHandler(*command)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.ServeHTTP)
	mux.HandleFunc("/api/sessions", handler.HandleListSessions)
	mux.Handle("/", http.FileServer(http.Dir(*staticDir)))

	log.Printf("Listening on %s", *listenAddr)

	go func() {
		if err := http.ListenAndServe(*listenAddr, mux); err != nil {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down")
}
