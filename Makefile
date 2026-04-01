.PHONY: dev build build-all test clean

build: frontend-build
	go build -o bin/oriel ./cmd/oriel/

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

build-all: frontend-build
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; \
		arch=$${platform#*/}; \
		echo "Building oriel for $$os/$$arch..."; \
		GOOS=$$os GOARCH=$$arch go build -o bin/oriel-$${os}-$${arch} ./cmd/oriel/; \
	done

frontend-build:
	cd frontend && npm run build

test: test-go test-frontend

test-go:
	go test ./... -v -count=1

test-frontend:
	cd frontend && npx vitest run

clean:
	rm -f bin/oriel
	rm -rf bin
	rm -rf frontend/dist
