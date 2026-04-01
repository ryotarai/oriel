package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/ryotarai/claude-code-wrapper-ui/frontend"
	"github.com/ryotarai/claude-code-wrapper-ui/internal/auth"
	"github.com/ryotarai/claude-code-wrapper-ui/internal/fileexplorer"
	"github.com/ryotarai/claude-code-wrapper-ui/internal/ws"
)

func main() {
	listenAddr := flag.String("listen-addr", "localhost:9111", "Listen address (e.g. :8080, 127.0.0.1:3000)")
	command := flag.String("command", "claude", "Command to run in pty")
	noOpen := flag.Bool("no-open", false, "Don't auto-open browser on startup")
	flag.Parse()

	token := auth.GenerateToken()

	handler := ws.NewHandler(*command)

	distFS, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.ServeHTTP)
	mux.HandleFunc("/api/sessions", handler.HandleListSessions)
	mux.HandleFunc("/api/diff", handler.HandleDiff)
	mux.HandleFunc("/api/files/tree", fileexplorer.HandleTree)
	mux.HandleFunc("/api/files/read", fileexplorer.HandleFile)
	mux.Handle("/", http.FileServer(http.FS(distFS)))

	url := fmt.Sprintf("http://%s/?token=%s", *listenAddr, token)
	log.Printf("Listening on %s", *listenAddr)
	log.Printf("Open %s", url)

	go func() {
		if err := http.ListenAndServe(*listenAddr, auth.Middleware(token, mux)); err != nil {
			log.Fatal(err)
		}
	}()

	if !*noOpen {
		openBrowser(url)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	for {
		s := <-sig
		if s == syscall.SIGTERM {
			log.Println("Received SIGTERM, shutting down")
			break
		}
		// SIGINT: prompt for confirmation
		fmt.Print("\nThis will terminate running claude processes. Shut down? (y/N): ")
		answerCh := make(chan string, 1)
		go func() {
			var answer string
			fmt.Scanln(&answer)
			answerCh <- answer
		}()
		select {
		case answer := <-answerCh:
			if answer == "y" || answer == "Y" {
				log.Println("Shutting down")
				return
			}
			fmt.Println("Cancelled. Press Ctrl-C again to be prompted.")
		case s := <-sig:
			// Second signal while waiting for input — force quit
			fmt.Println()
			log.Printf("Received %v again, shutting down", s)
			return
		}
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return
	}
	cmd.Start()
}
