import csv, json, os, glob, bisect
import numpy as np

ROOT = "records"
SESSIONS = [
    ("v5probe", "20261030-212214_v5probe"),
    ("v6clean384", "20261030-214353_v6clean"),
    ("v6clean", "20261030-215700_v6clean"),
    ("v7hands", "20261030-222201_v7hands"),
]

def frames_info(path):
    t = []
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.reader(f)
        head = next(rd)
        for row in rd:
            if row:
                t.append(int(row[1]))
    return head, len(t), (t[0] if t else 0), (t[-1] if t else 0)

def stats_session(d):
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8"))
    chunks = sorted(meta["chunks"], key=lambda c: c["index"])
    frames = 0; t0 = None; t1 = None
    ev_bytes = 0; vid_bytes = 0
    for ch in chunks:
        fpath = os.path.join(d, ch["frames"])
        head, n, a, b = frames_info(fpath)
        frames += n
        t0 = a if t0 is None else t0
        t1 = b
        ev_bytes += os.path.getsize(os.path.join(d, ch["events"]))
        vid_bytes += os.path.getsize(os.path.join(d, ch["video"]))
    span_ms = t1 - t0
    n_ev = 0; on = 0; cells = bytearray(1500)
    first_ev_t = None; last_ev_t = None
    nb = int(span_ms // 100) + 2
    buckets = np.zeros(nb, dtype=np.int64)
    for ch in chunks:
        with open(os.path.join(d, ch["events"]), newline="", encoding="utf-8") as f:
            rd = csv.reader(f)
            next(rd)
            for row in rd:
                if not row: continue
                t = int(row[1]); x = int(row[2]); y = int(row[3]); p = int(row[4])
                n_ev += 1
                if p == 1: on += 1
                cells[((y >> 3) * 50) + (x >> 3)] = 1
                if first_ev_t is None: first_ev_t = t
                last_ev_t = t
                k = (t - t0) // 100
                if 0 <= k < nb: buckets[k] += 1
    nz = buckets[buckets > 0]
    raw = frames * 800 * 480 * 2
    return dict(
        dir=os.path.basename(d), session=meta["session"],
        startedAt=meta["startedAt"], endedAt=meta["endedAt"],
        frames=frames, events=n_ev, chunks=len(chunks),
        board_t0_ms=t0, board_t1_ms=t1, span_s=round(span_ms / 1000.0, 3),
        fps_eff=round((frames - 1) * 1000.0 / span_ms, 3),
        events_per_s=round(n_ev / (span_ms / 1000.0), 2),
        events_per_frame=round(n_ev / frames, 2),
        on=on, off=n_ev - on, on_ratio=round(on / n_ev, 4),
        raw_frame_bytes=raw, events_csv_bytes=ev_bytes, video_bytes=vid_bytes,
        events_csv_ratio=round(ev_bytes / raw, 5),
        bytes_per_event=round(ev_bytes / n_ev, 3),
        grid_cells=int(sum(cells)),
        bucket100_n=int(len(buckets)),
        bucket100_nonzero=int(len(nz)),
        bucket100_p50=float(np.percentile(nz, 50)),
        bucket100_p95=float(np.percentile(nz, 95)),
        bucket100_max=int(nz.max()),
        bucket100_mean_nonzero=round(float(nz.mean()), 2),
        meta_counters=meta["counters"],
    )

def v7_zones_stats():
    d = os.path.join(ROOT, "20261030-222201_v7hands")
    z = json.load(open("report/figures/v7_zones.json", encoding="utf-8"))
    zones = z["zones"]
    t1s = [zz["t1"] for zz in zones]
    stats = [dict(name=zz["name"], t0=zz["t0"], t1=zz["t1"], label=zz["label"], view=zz["view"],
                  duration_s=round(zz["t1"] - zz["t0"], 2), ev=0, on=0, cells=bytearray(1500),
                  ev_per_s_json=zz.get("ev_per_s"), dx_p50=zz.get("dx_p50")) for zz in zones]
    frames = frames_info(os.path.join(d, "chunk-000.frames.csv"))
    board0 = frames[2]
    outside = 0
    with open(os.path.join(d, "chunk-000.events.csv"), newline="", encoding="utf-8") as f:
        rd = csv.reader(f); next(rd)
        for row in rd:
            if not row: continue
            rel = (int(row[1]) - board0) / 1000.0
            i = bisect.bisect_left(t1s, rel)
            if i >= len(zones) or rel < zones[i]["t0"]:
                outside += 1; continue
            s = stats[i]; s["ev"] += 1
            if int(row[4]) == 1: s["on"] += 1
            s["cells"][((int(row[3]) >> 3) * 50) + (int(row[2]) >> 3)] = 1
    out = []
    for s in stats:
        s["cells"] = int(sum(s["cells"]))
        s["off"] = s["ev"] - s["on"]
        s["on_ratio"] = round(s["on"] / s["ev"], 4) if s["ev"] else 0
        s["ev_per_s_measured"] = round(s["ev"] / s["duration_s"], 1) if s["duration_s"] else 0
        s.pop("cells", None) if False else None
        d2 = dict(s)
        out.append(d2)
    return out, outside

res = dict(sessions={}, v7_zones=[], v7_outside_events=None)
for key, sub in SESSIONS:
    res["sessions"][key] = stats_session(os.path.join(ROOT, sub))
    print(key, {k: res["sessions"][key][k] for k in ("frames", "events", "span_s", "fps_eff", "events_per_s", "events_per_frame", "on_ratio", "events_csv_ratio", "grid_cells", "bucket100_p50", "bucket100_p95")})
res["v7_zones"], res["v7_outside_events"] = v7_zones_stats()
print("outside", res["v7_outside_events"])
for s in res["v7_zones"]:
    print("zone", s["name"], s["t0"], s["t1"], s["ev"], s["ev_per_s_measured"], s["ev_per_s_json"], s["on_ratio"], s["cells"])
json.dump(res, open("report/evidence/event_stream_stats.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("STATS_OK")