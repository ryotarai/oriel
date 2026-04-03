package auth

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const cookieName = "oriel-token"

// GenerateToken returns a cryptographically random hex token.
func GenerateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Middleware returns an http.Handler that checks for a valid token in the
// query string or cookie. On first access with ?token=..., it sets a cookie
// so subsequent requests don't need the query parameter.
func Middleware(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for /api/noauth/ endpoints (e.g. Claude Code hooks)
		if strings.HasPrefix(r.URL.Path, "/api/noauth/") {
			next.ServeHTTP(w, r)
			return
		}

		// Check cookie first
		if c, err := r.Cookie(cookieName); err == nil && c.Value == token {
			next.ServeHTTP(w, r)
			return
		}

		// Check query parameter
		if r.URL.Query().Get("token") == token {
			http.SetCookie(w, &http.Cookie{
				Name:     cookieName,
				Value:    token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
				MaxAge:   int((30 * 24 * time.Hour).Seconds()),
			})
			// Redirect to strip token from URL (only for page loads, not API/WS)
			if r.Header.Get("Upgrade") == "" && !isAPI(r.URL.Path) {
				clean := *r.URL
				q := clean.Query()
				q.Del("token")
				clean.RawQuery = q.Encode()
				http.Redirect(w, r, clean.String(), http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	})
}

func isAPI(path string) bool {
	return len(path) >= 4 && path[:4] == "/api" || path == "/ws"
}
