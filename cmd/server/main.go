package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/ryotarai/claude-code-wrapper-ui/frontend"
	"github.com/ryotarai/claude-code-wrapper-ui/internal/ws"
)

func main() {
	listenAddr := flag.String("listen-addr", ":8080", "Listen address (e.g. :8080, 127.0.0.1:3000)")
	command := flag.String("command", "claude", "Command to run in pty")
	flag.Parse()

	handler := ws.NewHandler(*command)

	distFS, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.ServeHTTP)
	mux.HandleFunc("/api/sessions", handler.HandleListSessions)
	mux.Handle("/", http.FileServer(http.FS(distFS)))

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
