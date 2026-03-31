.PHONY: dev build build-all test clean

build: frontend-build
	go build -o server ./cmd/server/

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64
CMDS := server capture

build-all: frontend-build
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; \
		arch=$${platform#*/}; \
		for cmd in $(CMDS); do \
			echo "Building $$cmd for $$os/$$arch..."; \
			GOOS=$$os GOARCH=$$arch go build -o bin/$${cmd}-$${os}-$${arch} ./cmd/$$cmd/; \
		done; \
	done

frontend-build:
	cd frontend && npm run build

test: test-go test-frontend

test-go:
	go test ./... -v -count=1

test-frontend:
	cd frontend && npx vitest run

clean:
	rm -f server capture
	rm -rf bin
	rm -rf frontend/dist
