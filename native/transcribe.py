"""Explicit native media worker. It never searches a former plugin directory."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--model', choices=['tiny', 'base', 'small', 'medium'], default='small')
    parser.add_argument('--models-dir', required=True)
    args = parser.parse_args()
    source = Path(args.input)
    models = Path(args.models_dir)
    if not source.is_file() or not models.is_dir():
        raise ValueError('Explicit native media resources are required')
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device='cpu', compute_type='int8', download_root=str(models))
    segments, info = model.transcribe(str(source), beam_size=3, vad_filter=True)
    rows = [{'start_seconds': row.start, 'end_seconds': row.end, 'text': row.text} for row in segments]
    print(json.dumps({'text': '\n'.join(row['text'] for row in rows), 'segments': rows,
                      'language': info.language, 'uncertain': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
