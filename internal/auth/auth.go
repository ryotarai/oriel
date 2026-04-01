package auth

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"time"

	"github.com/ryotarai/oriel/internal/state"
)

const cookieName = "oriel-token"

// generateToken returns a cryptographically random hex token.
func generateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// LoadOrGenerateToken loads the auth token from the store, or generates a new
// one and saves it.
func LoadOrGenerateToken(store *state.Store) string {
	token, err := store.GetAuthToken()
	if err != nil {
		log.Printf("Failed to load auth token: %v, generating new one", err)
	}
	if token != "" {
		return token
	}
	token = generateToken()
	if err := store.SetAuthToken(token); err != nil {
		log.Printf("Failed to save auth token: %v", err)
	}
	return token
}

// Middleware returns an http.Handler that checks for a valid token in the
// query string or cookie. On first access with ?token=..., it sets a cookie
// so subsequent requests don't need the query parameter.
func Middleware(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
