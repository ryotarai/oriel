package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/ryotarai/oriel/frontend"
	"github.com/ryotarai/oriel/internal/auth"
	"github.com/ryotarai/oriel/internal/commits"
	"github.com/ryotarai/oriel/internal/config"
	"github.com/ryotarai/oriel/internal/fileexplorer"
	"github.com/ryotarai/oriel/internal/state"
	"github.com/ryotarai/oriel/internal/ws"
)

func main() {
	// Handle editor subcommand before parsing flags
	if len(os.Args) >= 2 && os.Args[1] == "editor" {
		runEditor()
		return
	}

	listenAddr := flag.String("listen-addr", "localhost:9111", "Listen address (e.g. :8080, 127.0.0.1:3000)")
	command := flag.String("command", "claude", "Command to run in pty")
	noOpen := flag.Bool("no-open", false, "Don't auto-open browser on startup")
	stateDB := flag.String("state-db", "", "Path to state database (default: ~/.config/oriel/state.sqlite3)")
	logLevel := flag.String("log-level", "info", "Log level (debug, info, warn, error)")
	tokenFile := flag.String("token-file", "", "Path to file containing auth token (token is read from file; file is created with a generated token if it does not exist)")
	flag.Parse()

	// Parse log level
	var slogLevel slog.Level
	switch strings.ToLower(*logLevel) {
	case "debug":
		slogLevel = slog.LevelDebug
	case "info":
		slogLevel = slog.LevelInfo
	case "warn", "warning":
		slogLevel = slog.LevelWarn
	case "error":
		slogLevel = slog.LevelError
	default:
		fmt.Fprintf(os.Stderr, "Unknown log level %q, using info\n", *logLevel)
		slogLevel = slog.LevelInfo
	}

	// Set up logging: stderr uses the configured level
	stderrHandler := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slogLevel})

	// Set up debug log file: captures all levels (debug and above)
	if home, err := os.UserHomeDir(); err == nil {
		logDir := filepath.Join(home, ".local", "oriel")
		os.MkdirAll(logDir, 0o755)
		logPath := filepath.Join(logDir, "debug.log")
		logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			slog.SetDefault(slog.New(stderrHandler))
			slog.Warn("Could not open debug log", "path", logPath, "error", err)
		} else {
			defer logFile.Close()
			os.Chmod(logPath, 0o600)
			fileHandler := slog.NewTextHandler(logFile, &slog.HandlerOptions{Level: slog.LevelDebug})
			slog.SetDefault(slog.New(multiHandler{stderrHandler, fileHandler}))
			slog.Debug("Debug log enabled", "path", logPath)
		}
	} else {
		slog.SetDefault(slog.New(stderrHandler))
	}

	dbPath := *stateDB
	if dbPath == "" {
		dbPath = state.DefaultPath()
	}
	store, err := state.Open(dbPath)
	if err != nil {
		slog.Error("Failed to open state database", "error", err)
		os.Exit(1)
	}
	defer store.Close()

	var token string
	if *tokenFile != "" {
		data, err := os.ReadFile(*tokenFile)
		if os.IsNotExist(err) {
			token = auth.GenerateToken()
			if err := os.WriteFile(*tokenFile, []byte(token), 0o600); err != nil {
				slog.Error("Failed to write token file", "path", *tokenFile, "error", err)
				os.Exit(1)
			}
		} else if err != nil {
			slog.Error("Failed to read token file", "path", *tokenFile, "error", err)
			os.Exit(1)
		} else {
			token = strings.TrimSpace(string(data))
		}
	} else {
		token = auth.GenerateToken()
	}

	handler := ws.NewHandler(*command, *listenAddr, store, token)

	distFS, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		slog.Error("Failed to load frontend dist", "error", err)
		os.Exit(1)
	}

	config.Load()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.ServeHTTP)
	mux.HandleFunc("/api/sessions", handler.HandleListSessions)
	mux.HandleFunc("/api/sessions/", handler.HandleHook) // Claude Code hook endpoints
	mux.HandleFunc("/api/diff", handler.HandleDiff)
	mux.HandleFunc("/api/dirs", fileexplorer.HandleDirs)
	mux.HandleFunc("/api/files/tree", fileexplorer.HandleTree)
	mux.HandleFunc("/api/files/read", fileexplorer.HandleFile)
	mux.HandleFunc("/api/config", handleConfig)
	mux.HandleFunc("/api/commits", commits.HandleList)
	mux.HandleFunc("/api/commits/show", commits.HandleShow)
	mux.HandleFunc("/api/state", handler.HandleLoadState)
	mux.HandleFunc("/api/state/save", handler.HandleSaveState)
	mux.Handle("/", http.FileServer(http.FS(distFS)))

	url := fmt.Sprintf("http://%s/?token=%s", *listenAddr, token)
	slog.Info("Listening", "addr", *listenAddr)
	fmt.Fprintf(os.Stderr, "Open %s\n", url)

	go func() {
		if err := http.ListenAndServe(*listenAddr, auth.Middleware(token, mux)); err != nil {
			slog.Error("HTTP server failed", "error", err)
			os.Exit(1)
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
			slog.Info("Received SIGTERM, shutting down")
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
				slog.Info("Shutting down")
				return
			}
			fmt.Println("Cancelled. Press Ctrl-C again to be prompted.")
		case s := <-sig:
			// Second signal while waiting for input — force quit
			fmt.Println()
			slog.Info("Received signal again, shutting down", "signal", s)
			return
		}
	}
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(config.Get())
	case http.MethodPut:
		var c config.Config
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := config.Set(c); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(c)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
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

// runEditor implements the "oriel editor" subcommand, invoked by Claude CLI
// as $EDITOR. It sends the file content to the Oriel backend, waits for the
// user to edit it in the web UI, and writes the result back to the file.
func runEditor() {
	fs := flag.NewFlagSet("editor", flag.ExitOnError)
	urlFlag := fs.String("url", "", "Backend URL")
	sessionFlag := fs.String("session", "", "Session ID")
	tokenFlag := fs.String("token", "", "Auth token")
	fs.Parse(os.Args[2:])

	tempfile := fs.Arg(0)
	if tempfile == "" {
		fmt.Fprintln(os.Stderr, "usage: oriel editor --url <url> --session <id> --token <token> <file>")
		os.Exit(1)
	}

	content, err := os.ReadFile(tempfile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to read %s: %v\n", tempfile, err)
		os.Exit(1)
	}

	body, _ := json.Marshal(map[string]string{
		"content": string(content),
	})

	editorURL := fmt.Sprintf("%s/api/sessions/%s/editor-open", *urlFlag, *sessionFlag)
	req, err := http.NewRequest(http.MethodPost, editorURL, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to create request: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "oriel-token="+*tokenFlag)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to contact backend: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	var result struct {
		Content   string `json:"content"`
		Cancelled bool   `json:"cancelled"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Fprintf(os.Stderr, "failed to decode response: %v\n", err)
		os.Exit(1)
	}

	if result.Cancelled {
		os.Exit(1)
	}

	if err := os.WriteFile(tempfile, []byte(result.Content), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write %s: %v\n", tempfile, err)
		os.Exit(1)
	}
}
