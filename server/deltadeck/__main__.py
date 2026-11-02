"""`python -m deltadeck` (also the PyInstaller entry point): same as `uv run deltadeck`."""

from deltadeck.cli import main  # absolute: PyInstaller runs this file as a top-level script

if __name__ == "__main__":
    main()
