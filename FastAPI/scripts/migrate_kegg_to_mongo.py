import json
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import MongoClient
from api.config import KEGG_DIR, MONGO_URI, MONGO_DB_NAME

BATCH_SIZE = 5000

def iter_kegg_documents():
    """Yield one flattened document per (sample, annotation_id) across every KEGG file."""
    sample_files = sorted(f for f in os.listdir(KEGG_DIR) if f.endswith(".ko.json"))

    for i, filename in enumerate(sample_files, start=1):
        sample_name = filename.removesuffix(".ko.json")
        path = os.path.join(KEGG_DIR, filename)

        with open(path, "r") as f:
            annotations = json.load(f)

        for annotation_id, entry in annotations.items():
            yield {
                "sample_name":   sample_name,
                "source":        "kegg",
                "annotation_id": annotation_id,
                "name":          entry.get("name"),
                "category":      entry.get("category"),
                "depth":         entry.get("depth"),
                "parent_id":     entry.get("parent_id"),
                "parent_name":   entry.get("parent_name"),
                "egc":           entry.get("egc"),
                "norm_egc":      entry.get("norm_egc"),
                "scaffolds":     entry.get("scaffolds", {}),
            }

        print(f"[{i}/{len(sample_files)}] read {sample_name} ({len(annotations)} annotations)")

def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    existing = db.annotations.count_documents({"source": "kegg"})
    print(f"Clearing {existing} existing source='kegg' documents before reloading...")
    db.annotations.delete_many({"source": "kegg"})

    batch = []
    total_inserted = 0

    for doc in iter_kegg_documents():
        batch.append(doc)
        if len(batch) >= BATCH_SIZE:
            db.annotations.insert_many(batch)
            total_inserted += len(batch)
            print(f"  inserted {total_inserted} documents so far...")
            batch = []

    if batch:
        db.annotations.insert_many(batch)
        total_inserted += len(batch)

    print(f"Done. Inserted {total_inserted} KEGG documents into '{MONGO_DB_NAME}.annotations'.")
    client.close()


if __name__ == "__main__":
    main()