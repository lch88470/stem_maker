
import os
import sys
import json
import shutil
import zipfile
import subprocess
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, render_template, abort
import yt_dlp

# --- Configuration ---
BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
SEPARATED_DIR = BASE_DIR / "separated"
MODEL_NAME = "htdemucs"  # default demucs model folder name
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
SEPARATED_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

# --- Helpers ---
def safe_title(text: str) -> str:
    """File-system safe title"""
    bad = '<>:"/\\|?*'
    for ch in bad:
        text = text.replace(ch, "")
    return " ".join(text.split()).strip()

def search_youtube(query: str, max_results: int = 6):
    """Use yt-dlp to search YouTube without downloading."""
    ydl_opts = {
        "quiet": True,
        "extract_flat": True,
        "skip_download": True,
        "default_search": "ytsearch",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        res = ydl.extract_info(f"ytsearch{max_results}:{query}", download=False)
    results = []
    for e in res.get("entries", []):
        results.append({
            "id": e.get("id"),
            "title": e.get("title"),
            "url": f"https://www.youtube.com/watch?v={e.get('id')}",
            "thumbnail": e.get("thumbnail")
        })
    return results

def download_audio(url: str, video_id: str, title: str):
    """Download audio as mp3 with deterministic filename <id>.mp3"""
    output_template = str(DOWNLOAD_DIR / f"{video_id}.%(ext)s")
    cmd = [
        "yt-dlp",
        "-x", "--audio-format", "mp3",
        "-o", output_template,
        url
    ]
    subprocess.run(cmd, check=True)
    mp3_path = DOWNLOAD_DIR / f"{video_id}.mp3"
    if not mp3_path.exists():
        raise FileNotFoundError(f"Expected file not found: {mp3_path}")
    # also save a metadata json we can reuse
    meta = {
        "id": video_id,
        "title": title,
        "safe_title": safe_title(title),
        "source_url": url
    }
    meta_path = SEPARATED_DIR / MODEL_NAME / video_id / "meta.json"
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2))
    return mp3_path

def run_demucs(audio_file: Path):
    """Run demucs using the current python interpreter for reliability."""
    cmd = [
        sys.executable, "-m", "demucs",
        "--device", "cpu",
        "--out", str(SEPARATED_DIR),
        str(audio_file)
    ]
    subprocess.run(cmd, check=True)

def clean_old_downloads(limit: int = 2):
    """Keep only the newest `limit` files in DOWNLOAD_DIR."""
    files = sorted(DOWNLOAD_DIR.glob("*"), key=lambda f: f.stat().st_mtime, reverse=True)
    for old_file in files[limit:]:
        try:
            old_file.unlink()
        except Exception as e:
            print(f"Failed to delete {old_file}: {e}")


@app.post("/api/process")
def api_process():
    data = request.get_json(force=True)
    url = data.get("url")
    video_id = data.get("id")
    title = data.get("title", video_id)
    if not url or not video_id:
        return jsonify({"error": "Missing url or id"}), 400
    try:
        # Clean old downloads first
        clean_old_downloads(limit=1)  # Keep only the latest 1 before downloading new

        # Download audio
        mp3 = download_audio(url, video_id, title)

        # Run demucs
        run_demucs(mp3)

        # Delete the downloaded mp3 to save space
        if mp3.exists():
            mp3.unlink()

        # Rename stems
        folder = SEPARATED_DIR / MODEL_NAME / Path(mp3).stem
        rename_stems(folder, title)
        stems = [f.name for f in folder.glob("*.wav")]

        return jsonify({
            "status": "done",
            "song": {"id": Path(mp3).stem, "title": title},
            "stems": stems
        })
    except subprocess.CalledProcessError as e:
        return jsonify({"error": f"Processing failed: {e}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def rename_stems(folder: Path, song_title: str):
    """Rename stems to '<title> - Stem.wav' if not already renamed."""
    mapping = {
        "vocals": "Vocals",
        "drums": "Drums",
        "bass": "Bass",
        "other": "Other",
        "guitar": "Guitar",
        "piano": "Piano"
    }
    for f in folder.glob("*.wav"):
        lower = f.stem.lower()
        label = None
        for key, nice in mapping.items():
            if key in lower:
                label = nice
                break
        if not label:
            continue
        new_name = f"{label}.wav"
        new_path = folder / new_name
        if f.name != new_name and not new_path.exists():
            f.rename(new_path)

def list_library():
    """List all processed songs with their stems."""
    root = SEPARATED_DIR / MODEL_NAME
    if not root.exists():
        return []
    items = []
    for song_dir in sorted(root.iterdir()):
        if not song_dir.is_dir():
            continue
        meta_path = song_dir / "meta.json"
        title = song_dir.name
        if meta_path.exists():
            try:
                import json as _json
                meta = _json.loads(meta_path.read_text())
                title = meta.get("title", title)
            except Exception:
                pass
        stems = [f.name for f in song_dir.glob("*.wav")]
        items.append({
            "id": song_dir.name,
            "title": title,
            "stems": stems
        })
    return items

def make_zip(song_id: str) -> Path:
    """Create a zip of stems for a given song id and return its path."""
    folder = SEPARATED_DIR / MODEL_NAME / song_id
    if not folder.exists():
        raise FileNotFoundError("Song not found")
    zip_path = folder.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in folder.glob("*.wav"):
            zf.write(f, arcname=f.name)
        meta = folder / "meta.json"
        if meta.exists():
            zf.write(meta, arcname="meta.json")
    return zip_path

# --- Routes ---
@app.route("/")
def index():
    return render_template("index.html")

@app.get("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"results": []})
    try:
        results = search_youtube(q)
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.post("/api/process")
def api_process():
    data = request.get_json(force=True)
    url = data.get("url")
    video_id = data.get("id")
    title = data.get("title", video_id)
    if not url or not video_id:
        return jsonify({"error": "Missing url or id"}), 400
    try:
        # Clean old downloads first
        clean_old_downloads(limit=1)  # Keep only the latest 1 before downloading new

        # Download audio
        mp3 = download_audio(url, video_id, title)

        # Run demucs
        run_demucs(mp3)

        # Delete the downloaded mp3 to save space
        if mp3.exists():
            mp3.unlink()

        # Rename stems
        folder = SEPARATED_DIR / MODEL_NAME / Path(mp3).stem
        rename_stems(folder, title)
        stems = [f.name for f in folder.glob("*.wav")]

        return jsonify({
            "status": "done",
            "song": {"id": Path(mp3).stem, "title": title},
            "stems": stems
        })
    except subprocess.CalledProcessError as e:
        return jsonify({"error": f"Processing failed: {e}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.get("/api/library")
def api_library():
    return jsonify({"items": list_library()})

@app.get("/api/stems/<song_id>")
def api_stems(song_id):
    folder = SEPARATED_DIR / MODEL_NAME / song_id
    if not folder.exists():
        return jsonify({"error": "Not found"}), 404
    stems = [f.name for f in folder.glob("*.wav")]
    meta = {}
    meta_path = folder / "meta.json"
    if meta_path.exists():
        try:
            import json as _json
            meta = _json.loads(meta_path.read_text())
        except Exception:
            pass
    return jsonify({"id": song_id, "title": meta.get("title", song_id), "stems": stems})

@app.get("/download/<song_id>/<filename>")
def download_file(song_id, filename):
    folder = SEPARATED_DIR / MODEL_NAME / song_id
    file_path = folder / filename
    try:
        if not file_path.resolve().is_file() or folder.resolve() not in file_path.resolve().parents:
            abort(404)
    except Exception:
        abort(404)
    return send_from_directory(folder, filename, as_attachment=True)

@app.get("/audio/<song_id>/<filename>")
def stream_audio(song_id, filename):
    folder = SEPARATED_DIR / MODEL_NAME / song_id
    file_path = folder / filename
    try:
        if not file_path.resolve().is_file() or folder.resolve() not in file_path.resolve().parents:
            abort(404)
    except Exception:
        abort(404)
    return send_from_directory(folder, filename)

@app.get("/download_zip/<song_id>")
def download_zip(song_id):
    try:
        zip_path = make_zip(song_id)
        return send_from_directory(zip_path.parent, zip_path.name, as_attachment=True)
    except Exception:
        abort(404)

# Static files for dev convenience
@app.get("/static/<path:filename>")
def static_files(filename):
    base = (Path(__file__).resolve().parent / "static")
    return send_from_directory(base, filename)

if __name__ == "__main__":
    app.run(debug=True)
