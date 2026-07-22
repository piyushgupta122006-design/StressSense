"""
StressSense — app.py
====================
A minimal Python web server that serves the StressSense static files
(index.html, style.css, script.js).

All stress classification logic runs entirely in the browser (script.js).
This server has one optional endpoint, /predict, that mirrors the same
weighted-scoring heuristic in pure Python — useful if you want to move
the classification server-side in the future.

Usage
-----
    # With Flask (recommended):
    pip install flask
    python app.py

    # Without Flask (Python built-in server, serves files only, no /predict):
    python -m http.server 5000

Then open http://localhost:5000 in your browser.
"""

import json
import math
import os

# ── Try to use Flask; fall back to http.server ─────────────────────────────

try:
    from flask import Flask, send_from_directory, request, jsonify

    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    app = Flask(__name__, static_folder=BASE_DIR)

    # ── Static file routes ────────────────────────────────────────────────

    @app.route("/")
    def index():
        return send_from_directory(BASE_DIR, "index.html")

    @app.route("/<path:filename>")
    def static_files(filename):
        return send_from_directory(BASE_DIR, filename)

    # ── /predict endpoint (optional Python-side classification) ──────────

    @app.route("/predict", methods=["POST"])
    def predict():
        """
        POST /predict
        Body (JSON):
        {
          "typingSpeed":      <float, WPM>,
          "errorRate":        <float, 0-1>,
          "rhythmVariation":  <float, ms std-dev>,
          "screenTime":       <float, hrs/day>,
          "nightUsage":       <float, hrs 12AM-5AM>,
          "appSwitches":      <int,   switches/day>
        }

        Response (JSON):
        {
          "score":      <int 0-40>,
          "category":   "Low" | "Moderate" | "High",
          "confidence": { "low": int, "moderate": int, "high": int },
          "signals":    [ { "name", "value", "impact", "description" }, ... ]
        }
        """
        data = request.get_json(force=True, silent=True) or {}

        typing_speed     = float(data.get("typingSpeed",     45))
        error_rate       = float(data.get("errorRate",       0.05))
        rhythm_variation = float(data.get("rhythmVariation", 120))
        screen_time      = float(data.get("screenTime",      6))
        night_usage      = float(data.get("nightUsage",      0.5))
        app_switches     = float(data.get("appSwitches",     45))

        result = analyze_stress(
            typing_speed, error_rate, rhythm_variation,
            screen_time, night_usage, app_switches
        )
        return jsonify(result)

    # ── Python stress engine (mirrors script.js logic) ───────────────────

    def clamp01(val, lo, hi):
        """Normalise val into [lo, hi] → [0, 1]."""
        if hi == lo:
            return 0.0
        return max(0.0, min(1.0, (val - lo) / (hi - lo)))

    def analyze_stress(typing_speed, error_rate, rhythm_variation,
                       screen_time, night_usage, app_switches):
        speed_c  = 1 - clamp01(typing_speed,     30,  70)
        error_c  =     clamp01(error_rate,         0, 0.1)
        rhythm_c =     clamp01(rhythm_variation,  50, 300)
        screen_c =     clamp01(screen_time,        2,  10)
        night_c  =     clamp01(night_usage,        0,   3)
        apps_c   =     clamp01(app_switches,      20, 150)

        raw = (
            speed_c  * 0.20 +
            error_c  * 0.20 +
            rhythm_c * 0.15 +
            screen_c * 0.20 +
            night_c  * 0.15 +
            apps_c   * 0.10
        )

        score = round(raw * 40)

        if score >= 27:
            category = "High"
        elif score >= 14:
            category = "Moderate"
        else:
            category = "Low"

        # Soft confidence (Gaussian spread around category centres)
        p_low  = max(0, 1 - abs(score -  7) / 20)
        p_mod  = max(0, 1 - abs(score - 20) / 20)
        p_high = max(0, 1 - abs(score - 33) / 20)
        total  = p_low + p_mod + p_high or 1

        conf_low  = round((p_low  / total) * 100)
        conf_mod  = round((p_mod  / total) * 100)
        conf_high = round((p_high / total) * 100)

        # Fix rounding so they always sum to 100
        diff = 100 - (conf_low + conf_mod + conf_high)
        conf_mod += diff

        confidence = {"low": conf_low, "moderate": conf_mod, "high": conf_high}

        def impact(v):
            if v < 0.35:
                return "positive"
            if v > 0.65:
                return "negative"
            return "neutral"

        signals = [
            {
                "name": "Typing Rhythm",
                "value": f"{round(rhythm_variation)}ms var",
                "impact": impact(rhythm_c),
                "description": "Consistency of keystroke timing",
            },
            {
                "name": "Typing Speed",
                "value": f"{round(typing_speed)} WPM",
                "impact": impact(speed_c),
                "description": "Words per minute compared to baseline",
            },
            {
                "name": "Error Rate",
                "value": f"{error_rate * 100:.1f}%",
                "impact": impact(error_c),
                "description": "Frequency of corrections and backspaces",
            },
            {
                "name": "Screen Time",
                "value": f"{screen_time:.1f} hrs",
                "impact": impact(screen_c),
                "description": "Total daily device usage",
            },
            {
                "name": "Night Usage",
                "value": f"{night_usage:.1f} hrs",
                "impact": impact(night_c),
                "description": "Usage between 12AM and 5AM",
            },
            {
                "name": "App Switching",
                "value": f"{int(app_switches)} times",
                "impact": impact(apps_c),
                "description": "Frequency of jumping between applications",
            },
        ]

        return {
            "score":      score,
            "category":   category,
            "confidence": confidence,
            "signals":    signals,
        }

    # ── Run ───────────────────────────────────────────────────────────────

    if __name__ == "__main__":
        port = int(os.environ.get("PORT", 5000))
        print(f"StressSense running at http://localhost:{port}")
        app.run(host="0.0.0.0", port=port, debug=False)

except ImportError:
    # ── Fallback: Python built-in http.server ─────────────────────────────
    import http.server
    import socketserver

    PORT = int(os.environ.get("PORT", 5000))
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=BASE_DIR, **kwargs)

        def log_message(self, fmt, *args):
            print(f"[StressSense] {self.address_string()} - {fmt % args}")

    print(f"StressSense running at http://localhost:{PORT}")
    print("(Flask not found — serving static files only, no /predict endpoint)")
    print("Install Flask for the full server:  pip install flask")

    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
