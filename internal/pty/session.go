package pty

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

type Session struct {
	cmd  *exec.Cmd
	ptmx *os.File
	mu   sync.Mutex
	done bool

	// waitOnce ensures cmd.Wait is called exactly once.
	waitOnce sync.Once
	waitErr  error
	doneCh   chan struct{}
}

func NewSession(command string, cols, rows uint16) (*Session, error) {
	cmd := exec.Command(command)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("COLUMNS=%d", cols),
		fmt.Sprintf("LINES=%d", rows),
		"TERM=xterm-256color",
	)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}

	s := &Session{
		cmd:    cmd,
		ptmx:   ptmx,
		doneCh: make(chan struct{}),
	}

	// Background goroutine: waits for the process and closes doneCh.
	go func() {
		s.waitOnce.Do(func() {
			s.waitErr = cmd.Wait()
		})
		close(s.doneCh)
	}()

	return s, nil
}

// Done returns a channel that is closed when the child process exits.
func (s *Session) Done() <-chan struct{} {
	return s.doneCh
}

func (s *Session) Read(buf []byte) (int, error) {
	return s.ptmx.Read(buf)
}

func (s *Session) Write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return fmt.Errorf("session closed")
	}
	_, err := s.ptmx.Write(data)
	return err
}

func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

func (s *Session) Close() error {
	s.mu.Lock()
	s.done = true
	s.mu.Unlock()

	s.ptmx.Close()

	// Wait for the background goroutine to finish cmd.Wait.
	<-s.doneCh

	err := s.waitErr
	if err != nil {
		// Closing the pty master sends SIGHUP to the child; treat that as a
		// clean exit rather than a caller-visible error.
		if exitErr, ok := err.(*exec.ExitError); ok {
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
				if status.Signal() == syscall.SIGHUP {
					return nil
				}
			}
		}
		return err
	}
	return nil
}
