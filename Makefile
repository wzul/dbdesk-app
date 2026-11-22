PYTHON ?= python3

.PHONY: install ui server run app sidecar bundle test clean

install:
	npm install
	npm --prefix ui install
	$(PYTHON) -m pip install -r backend/requirements.txt

ui:
	npm --prefix ui run build

server: ui
	$(PYTHON) backend/app.py

run: server

app:
	npm run app

sidecar: ui
	scripts/build-sidecar.sh

bundle: ui
	npm run bundle

test: ui
	$(PYTHON) -m unittest discover -s tests -v

clean:
	rm -rf ui/dist dist-sidecar build-sidecar src-tauri/target src-tauri/binaries/dbdesk-server-*
