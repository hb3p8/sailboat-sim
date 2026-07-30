.PHONY: all extract viewer clean

all: viewer

extract:
	python3 scripts/extract.py

viewer: extract
	python3 scripts/build_viewer.py

clean:
	rm -rf out viewer/index.html src/sv20/__pycache__
