import json
import sys
from typing import List

import face_recognition


def load_encodings(image_path: str) -> List[list]:
    image = face_recognition.load_image_file(image_path)
    # Try with increasing upsample levels to detect small/distant faces
    for upsample in (1, 2):
        locations = face_recognition.face_locations(image, number_of_times_to_upsample=upsample)
        if locations:
            return face_recognition.face_encodings(image, known_face_locations=locations)
    return []


def main() -> None:
    payload = json.load(sys.stdin)
    reference_path = payload["referencePath"]
    search_paths = payload.get("searchPaths", [])
    threshold = float(payload.get("threshold", 0.6))

    print("[python] Loading reference image", file=sys.stderr, flush=True)

    reference_encodings = load_encodings(reference_path)
    result = {
        "referenceFaces": len(reference_encodings),
        "matches": []
    }

    if not reference_encodings:
        for _ in search_paths:
            result["matches"].append({
                "isMatch": False,
                "confidence": 0,
                "facesFound": 0
            })
        print(json.dumps(result))
        return

    print(f"[python] Reference faces found: {len(reference_encodings)}", file=sys.stderr, flush=True)
    reference_encoding = reference_encodings[0]

    for index, search_path in enumerate(search_paths, start=1):
        print(f"[python] Processing search image {index}/{len(search_paths)}", file=sys.stderr, flush=True)
        search_encodings = load_encodings(search_path)
        faces_found = len(search_encodings)

        if faces_found == 0:
            result["matches"].append({
                "isMatch": False,
                "confidence": 0,
                "facesFound": 0
            })
            continue

        distances = face_recognition.face_distance(search_encodings, reference_encoding)
        min_distance = float(min(distances))
        confidence = max(0.0, min(1.0, 1.0 - min_distance))
        is_match = min_distance <= threshold

        result["matches"].append({
            "isMatch": bool(is_match),
            "confidence": confidence,
            "facesFound": faces_found
        })

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(str(exc))
        sys.exit(1)
