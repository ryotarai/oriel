package images

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"time"
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

	// Validate MIME type from Content-Type header of the part.
	ct := header.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(ct)
	ext, ok := mimeToExt[mediaType]
	if !ok {
		http.Error(w, fmt.Sprintf("unsupported image type: %s", mediaType), http.StatusUnsupportedMediaType)
		return
	}

	// Build save directory.
	home, err := os.UserHomeDir()
	if err != nil {
		http.Error(w, "cannot determine home directory", http.StatusInternalServerError)
		return
	}
	dir := filepath.Join(home, ".local", "oriel", "images")
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
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		os.Remove(savePath)
		http.Error(w, "cannot write image file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": savePath})
}
