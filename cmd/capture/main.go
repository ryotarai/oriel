package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/creack/pty"
	"gopkg.in/yaml.v3"
)

type Step struct {
	SendKeys string `yaml:"send_keys"`
	Wait     string `yaml:"wait"`
	SendLine string `yaml:"send_line"`
}

type Scenario struct {
	Name  string `yaml:"name"`
	Steps []Step `yaml:"steps"`
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: %s <scenario.yaml> <output-dir>\n", os.Args[0])
		os.Exit(1)
	}
	scenarioPath := os.Args[1]
	outDir := os.Args[2]

	data, err := os.ReadFile(scenarioPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to read scenario: %v\n", err)
		os.Exit(1)
	}

	var scenarios []Scenario
	if err := yaml.Unmarshal(data, &scenarios); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to parse scenario: %v\n", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create output dir: %v\n", err)
		os.Exit(1)
	}

	for _, s := range scenarios {
		fmt.Fprintf(os.Stderr, "=== Running scenario: %s ===\n", s.Name)
		if err := runScenario(s, outDir); err != nil {
			fmt.Fprintf(os.Stderr, "Scenario %q failed: %v\n", s.Name, err)
		}
	}
}

func runScenario(s Scenario, outDir string) error {
	outPath := fmt.Sprintf("%s/%s.raw", outDir, s.Name)
	f, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create output file: %w", err)
	}
	defer f.Close()

	cmd := exec.Command("claude")
	cmd.Env = append(os.Environ(), "COLUMNS=120", "LINES=40")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 120})
	if err != nil {
		return fmt.Errorf("start pty: %w", err)
	}
	defer ptmx.Close()

	// Collect output in background
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		tee := io.MultiWriter(os.Stderr, f)
		io.Copy(tee, ptmx)
	}()

	// Wait for Claude Code to start up
	time.Sleep(5 * time.Second)

	for i, step := range s.Steps {
		fmt.Fprintf(os.Stderr, "--- Step %d ---\n", i+1)

		if step.SendLine != "" {
			keys := expandKeys(step.SendLine + "\r")
			if _, err := ptmx.Write([]byte(keys)); err != nil {
				return fmt.Errorf("write send_line: %w", err)
			}
		}

		if step.SendKeys != "" {
			keys := expandKeys(step.SendKeys)
			if _, err := ptmx.Write([]byte(keys)); err != nil {
				return fmt.Errorf("write send_keys: %w", err)
			}
		}

		if step.Wait != "" {
			d, err := time.ParseDuration(step.Wait)
			if err != nil {
				return fmt.Errorf("parse wait duration %q: %w", step.Wait, err)
			}
			time.Sleep(d)
		}
	}

	// Wait for output to settle
	time.Sleep(3 * time.Second)

	// Send /exit
	ptmx.Write([]byte("/exit\r"))
	time.Sleep(2 * time.Second)

	cmd.Process.Signal(os.Interrupt)
	cmd.Wait()
	<-outputDone

	fmt.Fprintf(os.Stderr, "=== Output saved to %s ===\n", outPath)
	return nil
}

func expandKeys(s string) string {
	s = strings.ReplaceAll(s, "<enter>", "\r")
	s = strings.ReplaceAll(s, "<tab>", "\t")
	s = strings.ReplaceAll(s, "<esc>", "\x1b")
	s = strings.ReplaceAll(s, "<ctrl-c>", "\x03")
	s = strings.ReplaceAll(s, "<ctrl-d>", "\x04")
	s = strings.ReplaceAll(s, "<backspace>", "\x7f")
	return s
}
