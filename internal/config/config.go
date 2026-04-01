package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	SwapEnterKeys bool `json:"swapEnterKeys"`
}

var (
	mu      sync.RWMutex
	current = Config{SwapEnterKeys: true}
)

func configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "oriel", "config.json")
}

func Load() {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	json.Unmarshal(data, &current)
}

func Get() Config {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

func Set(c Config) error {
	mu.Lock()
	current = c
	mu.Unlock()

	path := configPath()
	os.MkdirAll(filepath.Dir(path), 0o755)
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
