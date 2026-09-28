# Third-party components

## Stockfish 19

Stockfish is developed by the Stockfish contributors and licensed under GPL-3.0. This project uses the official unmodified release as a separate executable.

- Project: https://stockfishchess.org/
- Release and source: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
- Installed license: `engines/stockfish-19/stockfish/Copying.txt`
- Installed source: `engines/stockfish-19/stockfish/src/`

The installer preserves the official archive's accompanying source, documentation, attribution, and license. `engines/release.json` records the archive URL and checksum. Redistribution must comply with the component licenses, including applicable corresponding-source requirements.

## python-chess / chess 1.11.2

Copyright Niklas Fiekas and contributors. GPL-3.0-or-later.

- Project and source: https://github.com/niklasf/python-chess
- Documentation: https://python-chess.readthedocs.io/

## Chess pieces

The piece SVGs rendered by `chess.svg` use the chess piece images by **Colin M. L. Burnett (Cburnett)**, licensed under **CC BY-SA 3.0**.

- Artwork: https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces
- License: https://creativecommons.org/licenses/by-sa/3.0/
- The original piece paths are served unmodified by `chess.svg.piece`.

## Screenshot recognition

`@scoriiu/fenshot` 0.1.4 and its bundled `chess-tiles-v2.onnx` model are distributed by SORTINO LABS S.R.L. (coachess.app) under the MIT license. The original classifier was trained on synthetic board images; third-party theme artwork used as training inputs is not included in this project.

- Project and source: https://github.com/scoriiu/fenshot
- Training provenance: https://github.com/scoriiu/fenshot/tree/main/tools/tile-classifier
- Installed license: `web/vendor/screenshot/FENSHOT-LICENSE.txt`

ONNX Runtime Web 1.26.0 is copyright Microsoft Corporation, licensed under MIT, and includes third-party components with their own notices.

- Project and source: https://github.com/microsoft/onnxruntime/tree/v1.26.0
- Installed license: `web/vendor/screenshot/ONNXRUNTIME-LICENSE.txt`
- Third-party notices: `web/vendor/screenshot/ONNXRUNTIME-ThirdPartyNotices.txt`

These browser assets are self-hosted and fetched only when importing an image. `web/vendor/screenshot/manifest.json` records their versions and SHA-256 checksums. Rebuild with `npm ci` followed by `npm run build:recognizer`; Node and npm are build-time tools, not server requirements.
