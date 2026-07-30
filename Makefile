.PHONY: all extract hull viewer clean

all: viewer

extract:
	python3 scripts/extract.py

hull: extract
	python3 scripts/build_hull.py

viewer: hull
	python3 scripts/build_viewer.py

clean:
	rm -rf out viewer/index.html src/sv20/__pycache__
