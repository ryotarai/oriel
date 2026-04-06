package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/ryotarai/oriel/internal/dirs"
)

type Config struct {
	SwapEnterKeys        bool `json:"swapEnterKeys"`
	SwapPaneWidthOnFocus bool `json:"swapPaneWidthOnFocus"`
}

var (
	mu      sync.RWMutex
	current = Config{SwapEnterKeys: false}
)

func configPath() string {
	return filepath.Join(dirs.ConfigDir(), "config.json")
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
