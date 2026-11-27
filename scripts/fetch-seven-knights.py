"""Fetch public 7Knights Hub game data into a fresh local snapshot directory."""
import argparse
import concurrent.futures
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import threading
import time

HOST = "www.7knightshub.com"
INDEXES = [
    "index", "items-index", "pets-index", "dungeons-index", "adventure-chapters",
    "costumes-index", "continents", "formation", "awaken-index",
    "titles-index", "collection-index", "tutorials-index", "arena", "total-war",
    "accessory-refining", "event-world", "gacha-index",
]
local = threading.local()


def download(folder, name):
    path = folder / (name + ".json")
    if path.exists():
        return
    for attempt in range(4):
        if not getattr(local, "connection", None):
            local.connection = http.client.HTTPSConnection(HOST, timeout=45)
        try:
            local.connection.request("GET", "/data/" + name + ".json",
                                     headers={"Accept-Encoding": "gzip"})
            response = local.connection.getresponse()
            body = response.read()
            if response.status != 200:
                raise OSError(f"HTTP {response.status} for {name}")
            if response.getheader("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            json.loads(body)
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(".part")
            partial.write_bytes(body)
            os.replace(partial, path)
            return
        except (OSError, http.client.HTTPException, ValueError):
            local.connection.close()
            local.connection = None
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def detail_paths(read):
    for group_id in read("awaken-index"):
        yield f"awaken/{int(group_id)}"
    for index, folder in [("index", "characters"), ("pets-index", "pets")]:
        for row in read(index):
            yield f"{folder}/{int(row['tid'])}"
    for row in read("items-index"):
        if row["category"] == "equipment":
            yield f"items/equipment/{int(row['id'])}"
    for row in read("adventure-chapters"):
        yield f"adventure/chapter-{int(row['landMarkId'])}"
    for row in read("dungeons-index"):
        yield f"dungeons/{row['type']}-{row['id']}"


# Only localized labels used as terminology. Dialogue, skill descriptions and story prose
# are intentionally not part of a subtitle glossary.
LABELS = {
    "name", "subName", "newSkillName", "baseSkillName", "setName", "currencyName",
    "statName", "variantLabel", "targetLabel", "species", "theme", "tag",
    "title", "frontRowLabel", "backRowLabel",
}


def walk_labels(node, field=""):
    if isinstance(node, list):
        for value in node:
            yield from walk_labels(value, field)
    elif isinstance(node, dict):
        if isinstance(node.get("en"), str) or isinstance(node.get("zh-Hant"), str):
            if field in LABELS:
                yield node
            elif field in {"description", "enhancedDescription", "effect"}:
                # Word order can differ between locales. Only align an effect if
                # the game highlighted one distinct status in each translation.
                effect = {}
                for lang in ("ko", "th", "zh-Hant"):
                    words = set(STATUS.findall(node.get(lang) or ""))
                    if len(words) != 1:
                        break
                    effect[lang] = words.pop()
                else:
                    yield effect
        else:
            for key, value in node.items():
                yield from walk_labels(value, key)


STATUS = re.compile(r"\[\[c:SkillToolTip_Purple\]\]([^\[\]\n]+)\[\[/c\]\]")


def clean(value):
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    if not any(char.isalpha() for char in text) or re.search(r"\[\[|\{[^}]*\}|<[^>]+>", text):
        return ""
    return text


def build(names, read, output):
    rows = set()
    for name in names:
        for bag in walk_labels(read(name)):
            ko, th, target = (clean(bag.get(key)) for key in ("ko", "th", "zh-Hant"))
            if target and (ko or th):
                rows.add((ko, th, target))
    if not rows:
        raise ValueError("No localized game terms")
    lines = [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in sorted(rows)]
    body = ",\n".join(lines)
    revision = hashlib.sha256(body.encode()).hexdigest()[:16]
    data = ('{\n"source":"https://www.7knightshub.com/",\n'
            '"columns":["ko","th","zh-Hant"],\n'
            f'"revision":"{revision}",\n"terms":[\n{body}\n]\n}}\n')
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(".tmp")
    partial.write_text(data, encoding="utf-8", newline="\n")
    os.replace(partial, output)
    print(f"{len(rows)} unique terms from {len(names)} files; revision {revision}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, help="use a new folder for each update; reuse it to resume")
    parser.add_argument("--offline", action="store_true", help="rebuild from an existing complete snapshot")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data/seven-knights-terms.json")
    args = parser.parse_args()
    folder = args.snapshot
    folder.mkdir(parents=True, exist_ok=True)
    read = lambda name: json.loads((folder / (name + ".json")).read_bytes())
    if not args.offline:
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as workers:
            for paths in (lambda: INDEXES, lambda: sorted(set(detail_paths(read)))):
                names = paths()
                jobs = [workers.submit(download, folder, name) for name in names]
                for count, job in enumerate(concurrent.futures.as_completed(jobs), 1):
                    job.result()
                    if count % 150 == 0 or count == len(jobs):
                        print(f"{count}/{len(jobs)} files verified", flush=True)
    build(INDEXES + sorted(set(detail_paths(read))), read, args.output)


if __name__ == "__main__":
    main()
