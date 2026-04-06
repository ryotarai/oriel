package dirs

import (
	"os"
	"path/filepath"
)

// ConfigDir returns the Oriel configuration directory.
// Uses ORIEL_CONFIG_DIR env var if set, otherwise ~/.config/oriel.
func ConfigDir() string {
	if v := os.Getenv("ORIEL_CONFIG_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "oriel")
}

// LocalDir returns the Oriel local data directory.
// Uses ORIEL_LOCAL_DIR env var if set, otherwise ~/.local/oriel.
func LocalDir() string {
	if v := os.Getenv("ORIEL_LOCAL_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "oriel")
}
