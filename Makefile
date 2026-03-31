.PHONY: dev build test clean

build: frontend-build
	go build -o server ./cmd/server/

frontend-build:
	cd frontend && npm run build

test: test-go test-frontend

test-go:
	go test ./... -v -count=1

test-frontend:
	cd frontend && npx vitest run

clean:
	rm -f server capture
	rm -rf frontend/dist
