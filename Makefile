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

frontend/node_modules: frontend/package.json frontend/package-lock.json
	cd frontend && npm install
	touch frontend/node_modules

frontend-build: frontend/node_modules
	cd frontend && npm run build

test: test-go test-frontend test-e2e

test-go:
	go test ./... -v -count=1

test-frontend: frontend/node_modules
	cd frontend && npx vitest run

tests/e2e/node_modules: tests/e2e/package.json tests/e2e/package-lock.json
	cd tests/e2e && npm install
	touch tests/e2e/node_modules

test-e2e: build tests/e2e/node_modules
	cd tests/e2e && npx playwright test

clean:
	rm -rf bin
	rm -rf frontend/dist
	rm -rf frontend/node_modules
	rm -rf tests/e2e/node_modules
