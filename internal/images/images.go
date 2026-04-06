package images

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ryotarai/oriel/internal/dirs"
)

const maxImageSize = 10 * 1024 * 1024 // 10 MB

var mimeToExt = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	"image/bmp":  ".bmp",
	"image/tiff": ".tiff",
}

func HandleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit total request body to slightly above max to detect oversized files.
	r.Body = http.MaxBytesReader(w, r.Body, maxImageSize+1024)

	if err := r.ParseMultipartForm(maxImageSize); err != nil {
		http.Error(w, "file too large or invalid form", http.StatusRequestEntityTooLarge)
		return
	}

	file, header, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "missing 'image' field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Validate size.
	if header.Size > maxImageSize {
		http.Error(w, "file exceeds 10 MB limit", http.StatusRequestEntityTooLarge)
		return
	}

	// Detect actual content type from file bytes (don't trust client-supplied Content-Type).
	sniff := make([]byte, 512)
	n, err := io.ReadFull(file, sniff)
	if err != nil && err != io.ErrUnexpectedEOF {
		http.Error(w, "cannot read image file", http.StatusInternalServerError)
		return
	}
	sniff = sniff[:n]
	detectedType := http.DetectContentType(sniff)
	mediaType, _, _ := mime.ParseMediaType(detectedType)
	ext, ok := mimeToExt[mediaType]
	if !ok {
		http.Error(w, fmt.Sprintf("unsupported image type: %s", mediaType), http.StatusUnsupportedMediaType)
		return
	}

	// Build save directory.
	dir := filepath.Join(dirs.LocalDir(), "images")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "cannot create image directory", http.StatusInternalServerError)
		return
	}

	// Generate filename: <YYYYMMDD-HHMMSS>-<8-char hex><ext>
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		http.Error(w, "cannot generate filename", http.StatusInternalServerError)
		return
	}
	timestamp := time.Now().Format("20060102-150405")
	filename := fmt.Sprintf("%s-%s%s", timestamp, hex.EncodeToString(suffix), ext)
	savePath := filepath.Join(dir, filename)

	// Write file with 0600 permissions.
	out, err := os.OpenFile(savePath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		http.Error(w, "cannot create image file", http.StatusInternalServerError)
		return
	}

	// Write sniffed bytes + rest of file.
	if _, err := io.Copy(out, io.MultiReader(bytes.NewReader(sniff), file)); err != nil {
		out.Close()
		os.Remove(savePath)
		http.Error(w, "cannot write image file", http.StatusInternalServerError)
		return
	}

	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(savePath)
		http.Error(w, "cannot flush image file", http.StatusInternalServerError)
		return
	}
	if err := out.Close(); err != nil {
		slog.Warn("failed to close image file", "path", savePath, "error", err)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"path": savePath}); err != nil {
		slog.Warn("failed to write image save response", "error", err)
	}
}
