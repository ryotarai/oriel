package pty_test

import (
	"bytes"
	"testing"
	"time"

	ptylib "github.com/ryotarai/oriel/internal/pty"
)

func TestSession_StartAndWrite(t *testing.T) {
	s, err := ptylib.NewSession("cat", 80, 24, "", nil)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer s.Close()

	if err := s.Write([]byte("hello\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	buf := make([]byte, 256)
	var out bytes.Buffer
	deadline := time.After(2 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatalf("Timed out waiting for output, got: %q", out.String())
		default:
		}
		n, err := s.Read(buf)
		if err != nil {
			break
		}
		out.Write(buf[:n])
		if bytes.Contains(out.Bytes(), []byte("hello")) {
			break
		}
	}

	if !bytes.Contains(out.Bytes(), []byte("hello")) {
		t.Errorf("Expected output to contain 'hello', got %q", out.String())
	}
}

func TestSession_Resize(t *testing.T) {
	s, err := ptylib.NewSession("cat", 80, 24, "", nil)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer s.Close()

	if err := s.Resize(120, 40); err != nil {
		t.Errorf("Resize: %v", err)
	}
}

func TestSession_Close(t *testing.T) {
	s, err := ptylib.NewSession("cat", 80, 24, "", nil)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	if err := s.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}

	err = s.Write([]byte("test"))
	if err == nil {
		t.Error("Expected error writing to closed session")
	}
}
